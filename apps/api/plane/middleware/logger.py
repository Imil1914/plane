# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import hashlib
import hmac
import logging
import re
import time
from urllib.parse import parse_qsl, urlencode

# Django imports
from django.conf import settings
from django.http import HttpRequest

# Third party imports
from rest_framework.request import Request

# Module imports
from plane.utils.ip_address import get_client_ip
from plane.utils.exception_logger import log_exception
from plane.bgtasks.logger_task import process_logs

api_logger = logging.getLogger("plane.api.request")

# Credentials must never reach the logs (PPM RC review, application logs):
# - The per-request log line carries the path WITHOUT the query string. Query strings hold one-time credentials
#   (password-reset and invitation tokens, OAuth code/state, presigned-URL signatures) and personal data (e-mail in
#   invitation links); a list of "secret" parameter names would always lag behind new ones, while the query adds
#   nothing to an operational request log (method, route, status, duration).
# - Path segments that ARE credentials are masked: URL kwargs named like a secret (``reset-password/<uidb64>/<token>/``)
#   and, for paths that did not resolve (404 probes), the reset-password routes by pattern.
REDACTED = "[redacted]"
SECRET_PATH_KWARG = re.compile(r"^(uidb64|token)$|(token|secret|signature|password)$", re.IGNORECASE)
SECRET_PATH_PATTERN = re.compile(r"(/reset-password/)[^/]+/[^/]+")
# Query parameters whose values are redacted where a query string is kept (the external API audit record).
SECRET_QUERY_PARAM = re.compile(r"token|key|code|state|password|secret|signature|uidb64|invitation|^x-amz-", re.I)


def loggable_path(request) -> str:
    """The request path for logs: no query string, credential path segments masked."""
    path = request.path
    match = getattr(request, "resolver_match", None)
    if match is not None:
        secrets = {str(value) for name, value in match.kwargs.items() if value and SECRET_PATH_KWARG.search(name)}
        if secrets:
            path = "/".join(REDACTED if segment in secrets else segment for segment in path.split("/"))
    return SECRET_PATH_PATTERN.sub(rf"\1{REDACTED}/{REDACTED}", path)


def redacted_query_string(query_string: str) -> str:
    """The query string with the values of credential-like parameters replaced by ``[redacted]``."""
    pairs = parse_qsl(query_string, keep_blank_values=True)
    return urlencode([(key, REDACTED if SECRET_QUERY_PARAM.search(key) else value) for key, value in pairs])


class RequestLoggerMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def _should_log_route(self, request: Request | HttpRequest) -> bool:
        """
        Determines whether a route should be logged based on the request and status code.
        """
        # Don't log health checks
        if request.path == "/" and request.method == "GET":
            return False
        return True

    def __call__(self, request):
        # get the start time
        start_time = time.time()

        # Get the response
        response = self.get_response(request)

        # calculate the duration
        duration = time.time() - start_time

        # Check if logging is required
        log_true = self._should_log_route(request=request)

        # If logging is not required, return the response
        if not log_true:
            return response

        user_id = (
            request.user.id if getattr(request, "user") and getattr(request.user, "is_authenticated", False) else None
        )

        user_agent = request.META.get("HTTP_USER_AGENT", "")

        # Log the request information: method, path (no query string, credentials masked), status, timing and who.
        # Request bodies and headers (other than the user agent) are never part of this record.
        path = loggable_path(request)
        api_logger.info(
            f"{request.method} {path} {response.status_code}",
            extra={
                "path": path,
                "method": request.method,
                "status_code": response.status_code,
                "duration_ms": int(duration * 1000),
                "remote_addr": get_client_ip(request),
                "user_agent": user_agent,
                "user_id": user_id,
            },
        )

        # return the response
        return response


class APITokenLogMiddleware:
    """
    Middleware to log External API requests to PostgreSQL.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request_body = request.body
        response = self.get_response(request)
        self.process_request(request, response, request_body)
        return response

    def _safe_decode_body(self, content):
        """
        Safely decodes request/response body content, handling binary data.
        Returns None if content is None, or a string representation of the content.
        """
        # If the content is None, return None
        if content is None:
            return None

        # If the content is an empty bytes object, return None
        if content == b"":
            return None

        # Check if content is binary by looking for common binary file signatures
        if content.startswith(b"\x89PNG") or content.startswith(b"\xff\xd8\xff") or content.startswith(b"%PDF"):
            return "[Binary Content]"

        try:
            return content.decode("utf-8")
        except UnicodeDecodeError:
            return "[Could not decode content]"

    # Headers whose values must never be persisted in plaintext logs (the Referer may carry the one-time token of
    # the page it came from, e.g. a password-reset link)
    SENSITIVE_HEADERS = frozenset(
        {"x-api-key", "authorization", "proxy-authorization", "cookie", "x-csrftoken", "referer"}
    )

    def _redacted_headers(self, request):
        """
        Returns the request headers as a string with sensitive values redacted,
        so that credentials such as the API key are never stored in plaintext.
        """
        redacted = {
            key: ("[REDACTED]" if key.lower() in self.SENSITIVE_HEADERS else value)
            for key, value in request.headers.items()
        }
        return str(redacted)

    def process_request(self, request, response, request_body):
        api_key_header = "X-Api-Key"
        api_key = request.headers.get(api_key_header)

        # If the API key is not present, return
        if not api_key:
            return

        try:
            log_data = {
                # Tokenize the (high-entropy) API key into a stable, non-reversible
                # identifier so logs can be correlated to a token without ever
                # persisting the raw key. A keyed HMAC is used rather than a bare
                # hash so the digest cannot be precomputed from a known key value.
                "token_identifier": hmac.new(
                    settings.SECRET_KEY.encode(), api_key.encode(), hashlib.sha256
                ).hexdigest(),
                "path": request.path,
                "method": request.method,
                "query_params": redacted_query_string(request.META.get("QUERY_STRING", "")),
                "headers": self._redacted_headers(request),
                "body": self._safe_decode_body(request_body) if request_body else None,
                "response_body": self._safe_decode_body(response.content) if response.content else None,
                "response_code": response.status_code,
                "ip_address": get_client_ip(request=request),
                "user_agent": request.META.get("HTTP_USER_AGENT", None),
            }

            process_logs.delay(log_data=log_data)

        except Exception as e:
            log_exception(e)

        return None
