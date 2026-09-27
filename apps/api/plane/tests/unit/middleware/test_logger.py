# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""
Unit tests for the request loggers (APITokenLogMiddleware, RequestLoggerMiddleware).

Covers the credential-hygiene guarantees:
- the raw API key is never persisted (a non-reversible hash is stored instead)
- sensitive request headers are redacted before being logged
- the per-request log line never carries a query string, a request body or request headers, and credential path
  segments (password-reset uid/token) are masked (PPM RC review, application logs)
"""

import hashlib
import hmac
from unittest.mock import Mock, patch

import pytest
from django.conf import settings
from django.contrib.auth.models import AnonymousUser
from django.http import HttpResponse
from django.test import RequestFactory
from django.urls import resolve

from plane.middleware.logger import APITokenLogMiddleware, RequestLoggerMiddleware


@pytest.fixture
def request_factory():
    return RequestFactory()


@pytest.fixture
def middleware():
    return APITokenLogMiddleware(Mock(return_value=HttpResponse(b"{}")))


@pytest.mark.unit
class TestAPITokenLogMiddleware:
    API_KEY = "plane_api_supersecretvalue"
    AUTHORIZATION = "Bearer secret-bearer-token"
    COOKIE = "sessionid=secret-session-value"

    def _captured_log_data(self, middleware, request_factory):
        request = request_factory.get(
            "/api/v1/workspaces/",
            HTTP_X_API_KEY=self.API_KEY,
            HTTP_AUTHORIZATION=self.AUTHORIZATION,
            HTTP_COOKIE=self.COOKIE,
        )
        request.user = AnonymousUser()
        response = HttpResponse(b"{}")
        with patch("plane.middleware.logger.process_logs") as process_logs:
            middleware.process_request(request, response, request_body=b"")
            assert process_logs.delay.called
            return process_logs.delay.call_args.kwargs["log_data"]

    def test_token_identifier_is_hashed_not_plaintext(self, middleware, request_factory):
        log_data = self._captured_log_data(middleware, request_factory)

        expected_hash = hmac.new(settings.SECRET_KEY.encode(), self.API_KEY.encode(), hashlib.sha256).hexdigest()
        assert log_data["token_identifier"] == expected_hash
        assert self.API_KEY not in log_data["token_identifier"]

    def test_sensitive_headers_are_redacted(self, middleware, request_factory):
        log_data = self._captured_log_data(middleware, request_factory)

        # None of the sensitive header values may appear in the logged headers.
        assert self.API_KEY not in log_data["headers"]
        assert self.AUTHORIZATION not in log_data["headers"]
        assert self.COOKIE not in log_data["headers"]
        assert "[REDACTED]" in log_data["headers"]

    def test_no_log_without_api_key(self, middleware, request_factory):
        request = request_factory.get("/api/v1/workspaces/")
        request.user = AnonymousUser()
        with patch("plane.middleware.logger.process_logs") as process_logs:
            middleware.process_request(request, HttpResponse(b"{}"), request_body=b"")
            assert not process_logs.delay.called

    def test_query_string_secrets_and_referer_are_redacted(self, middleware, request_factory):
        request = request_factory.get(
            "/api/v1/workspaces/?cursor=100:1:0&token=planted-query-token&password=planted-pass&X-Amz-Signature=abc",
            HTTP_X_API_KEY=self.API_KEY,
            HTTP_REFERER="https://ppm.example.test/accounts/reset-password?uidb64=MTIz&token=planted-referer-token",
        )
        request.user = AnonymousUser()
        with patch("plane.middleware.logger.process_logs") as process_logs:
            middleware.process_request(request, HttpResponse(b"{}"), request_body=b"")
            log_data = process_logs.delay.call_args.kwargs["log_data"]

        for planted in ("planted-query-token", "planted-pass", "planted-referer-token", "X-Amz-Signature=abc"):
            assert planted not in log_data["query_params"]
            assert planted not in log_data["headers"]
        assert "cursor=100%3A1%3A0" in log_data["query_params"]


RESET_TOKEN = "c0ffee-planted-reset-token-0123456789"
RESET_UID = "MTIzNDU2"


def _run_request_logger(request, *, resolve_path=True):
    """Run RequestLoggerMiddleware like Django does (URL resolved during get_response); return the log call."""

    def get_response(req):
        if resolve_path:
            req.resolver_match = resolve(req.path_info)
        return HttpResponse(b"ok")

    request.user = AnonymousUser()
    with patch("plane.middleware.logger.api_logger") as api_logger:
        RequestLoggerMiddleware(get_response)(request)
    assert api_logger.info.call_count == 1
    (message,), kwargs = api_logger.info.call_args
    return message, kwargs["extra"]


def _logged_text(message, extra):
    return message + " " + " ".join(str(value) for value in extra.values())


@pytest.mark.unit
class TestRequestLoggerMiddleware:
    def test_reset_password_token_in_the_path_is_not_logged(self, request_factory):
        message, extra = _run_request_logger(
            request_factory.post(f"/auth/reset-password/{RESET_UID}/{RESET_TOKEN}/?next_path=/profile")
        )

        logged = _logged_text(message, extra)
        assert RESET_TOKEN not in logged
        assert RESET_UID not in logged
        assert message == "POST /auth/reset-password/[redacted]/[redacted]/ 200"
        assert extra["path"] == "/auth/reset-password/[redacted]/[redacted]/"

    def test_space_reset_password_path_that_did_not_resolve_is_masked(self, request_factory):
        message, extra = _run_request_logger(
            request_factory.get(f"/auth/spaces/reset-password/{RESET_UID}/{RESET_TOKEN}/unknown/"),
            resolve_path=False,
        )

        assert RESET_TOKEN not in _logged_text(message, extra)
        assert extra["path"] == "/auth/spaces/reset-password/[redacted]/[redacted]/unknown/"

    def test_query_string_is_never_logged(self, request_factory):
        message, extra = _run_request_logger(
            request_factory.get(
                "/auth/github/callback/?code=planted-oauth-code&state=planted-state"
                "&token=planted-token&email=owner%40example.test"
            )
        )

        logged = _logged_text(message, extra)
        for planted in ("planted-oauth-code", "planted-state", "planted-token", "owner", "?"):
            assert planted not in logged
        assert message == "GET /auth/github/callback/ 200"

    def test_request_body_and_headers_are_not_logged(self, request_factory):
        request = request_factory.post(
            "/auth/sign-in/",
            data={"email": "owner@example.test", "password": "planted-body-password"},
            HTTP_COOKIE="session-id=planted-session-cookie",
            HTTP_AUTHORIZATION="Bearer planted-bearer",
            HTTP_X_API_KEY="plane_api_plantedplantedplanted",
            HTTP_REFERER="https://ppm.example.test/accounts/reset-password?token=planted-referer",
            HTTP_USER_AGENT="smoke/1.0",
        )

        message, extra = _run_request_logger(request)

        logged = _logged_text(message, extra)
        for planted in (
            "planted-body-password",
            "owner@example.test",
            "planted-session-cookie",
            "planted-bearer",
            "plane_api_planted",
            "planted-referer",
        ):
            assert planted not in logged
        assert set(extra) == {"path", "method", "status_code", "duration_ms", "remote_addr", "user_agent", "user_id"}
        assert extra["user_agent"] == "smoke/1.0"

    def test_ordinary_paths_keep_their_identifiers(self, request_factory):
        path = "/api/workspaces/acme/projects/0f05cbf2-cbe6-4104-9984-f0279c3a8109/issues/"
        message, extra = _run_request_logger(request_factory.get(f"{path}?per_page=50"))

        assert extra["path"] == path
        assert message == f"GET {path} 200"
