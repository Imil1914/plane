"""G2.2 R2, R3, R5–R7 — the endpoints of PPM's OpenID Connect provider under ``/auth/oidc/``.

Built on django-oauth-toolkit views, with PPM's rules on top:

- every endpoint answers 404 unless ``PPM_GIT_SSO_ENABLED=1`` and the provider is fully configured (switch, R26);
- ``authorize/`` without a PPM session keeps the request and sends the person to the PPM sign-in with
  ``next_path=/auth/oidc/continue/<id>/`` (R6); with a session the Git server gets a code at once — it is a trusted
  client, there is no consent screen; people who may not sign in get ``access_denied`` (R5);
- errors of an unknown client or redirect URI are a plain page in Russian with the standard OAuth code, never a
  redirect (R7);
- ``token/`` accepts only the authorization-code and refresh-token grants and counts only failed client
  authentications per client address; ``continue/`` and ``authorize/`` are rate limited per client address (R7);
- discovery: the public document has public addresses only; the internal one (for Forgejo inside the bundle) keeps
  ``issuer`` and ``authorization_endpoint`` public and points the back channel to ``PPM_OIDC_INTERNAL_URL`` (R2).
"""

import json
import logging

from django.conf import settings
from django.http import Http404, HttpResponseRedirect, JsonResponse
from django.shortcuts import render
from django.utils.decorators import method_decorator
from django.views import View
from django.views.decorators.cache import never_cache
from django.views.decorators.csrf import csrf_exempt
from oauth2_provider import views as toolkit_views
from oauth2_provider.exceptions import OAuthToolkitError
from oauth2_provider.models import get_application_model
from oauthlib.oauth2.rfc6749 import errors as oauth2_errors

from plane.authentication.utils.host import base_host
from plane.ppm_oidc import continuation, state, throttling
from plane.utils.path_validator import get_safe_redirect_url

logger = logging.getLogger("plane.api")

MESSAGE_TEMPLATE = "ppm_oidc/message.html"
SCOPES_SUPPORTED = ["openid", "profile", "email", "groups"]
CLAIMS_SUPPORTED = ["sub", "name", "email", "email_verified", "nickname", "preferred_username", "groups"]
# Hidden from error reports (DEBUG pages, mail_admins); the toolkit itself hides only "password" and "client_secret".
SENSITIVE_PARAMETERS = ("code", "code_verifier", "refresh_token", "client_secret", "password", "access_token")

EXPIRED_TITLE = "Ссылка для входа устарела"
EXPIRED_TEXT = "Ссылка для входа устарела. Вернитесь на Git-сервер и нажмите «Войти через PPM» ещё раз."
FAILED_TITLE = "Не удалось выполнить вход через PPM"
FAILED_TEXT = (
    "Git-сервер прислал запрос входа, который PPM не может выполнить. Вернитесь на Git-сервер и нажмите «Войти через "
    "PPM» ещё раз. Если ошибка повторится, сообщите администратору PPM."
)
UNAVAILABLE_TITLE = "Вход через PPM временно недоступен"
UNAVAILABLE_TEXT = "Клиент Git-сервера в PPM настроен не полностью. Сообщите администратору PPM."
TOO_MANY_TITLE = "Слишком много попыток"
TOO_MANY_TEXT = "Слишком много попыток входа с этого адреса. Подождите минуту и попробуйте снова."


def _message_page(request, *, title, text, status, error_code=None, headers=None):
    response = render(
        request,
        MESSAGE_TEMPLATE,
        {
            "title": title,
            "text": text,
            "error_code": error_code,
            "git_server_url": (getattr(settings, "PPM_FORGEJO_PUBLIC_URL", "") or "").rstrip("/"),
        },
        status=status,
    )
    for name, value in (headers or {}).items():
        response[name] = value
    return response


def _expired_page(request):
    return _message_page(request, title=EXPIRED_TITLE, text=EXPIRED_TEXT, status=410)


def _too_many_page(request, retry_after):
    return _message_page(
        request, title=TOO_MANY_TITLE, text=TOO_MANY_TEXT, status=429, headers={"Retry-After": str(retry_after)}
    )


def _oauth_json_error(error, status, *, headers=None):
    response = JsonResponse({"error": error}, status=status)
    response["Cache-Control"] = "no-store"
    response["Pragma"] = "no-cache"
    for name, value in (headers or {}).items():
        response[name] = value
    return response


def _sign_in_url(request, continue_id):
    """The PPM sign-in (the web app root) with ``next_path=/auth/oidc/continue/<id>/`` (R6)."""
    return get_safe_redirect_url(
        base_url=base_host(request=request, is_app=True),
        next_path=continuation.continue_path(continue_id),
        params={},
    )


class SingleSignOnSwitchMixin:
    """Every endpoint of the provider answers 404 unless single sign-on is on and configured; then the request rate
    of the endpoint's client address is checked (R7)."""

    throttle_class = None

    def dispatch(self, request, *args, **kwargs):
        if not state.sso_is_enabled():
            raise Http404
        if self.throttle_class is not None:
            allowed, retry_after = throttling.allows(self.throttle_class, request)
            if not allowed:
                return self.throttled(request, retry_after)
        return super().dispatch(request, *args, **kwargs)

    def throttled(self, request, retry_after):
        return _too_many_page(request, retry_after)


@method_decorator(never_cache, name="dispatch")
class PpmAuthorizationView(SingleSignOnSwitchMixin, toolkit_views.AuthorizationView):
    # The Git server is a trusted client: there is no consent form, hence nothing to POST.
    http_method_names = ["get"]
    # Every request writes something: a kept request in the cache (anonymous) or a code in the database.
    throttle_class = throttling.AuthorizeThrottle

    def get(self, request, *args, **kwargs):
        if not state.user_may_sign_in(request.user):
            # R5: a bot or a person without e-mail — Forgejo shows its sign-in error.
            return self._error_redirect(oauth2_errors.AccessDeniedError)
        return super().get(request, *args, **kwargs)

    def handle_no_permission(self):
        prompt = set(self.request.GET.get("prompt", "").split())
        if prompt & {"none", "login", "create"}:
            # The toolkit answers login_required to prompt=none, 400 to prompt=create (not supported) and calls
            # handle_prompt_login() below for prompt=login.
            return super().handle_no_permission()
        return self._remember_and_sign_in()

    def handle_prompt_login(self):
        # PPM cannot re-authenticate a person on request; OpenID Connect Core 3.1.2.1 wants login_required then.
        return self._error_redirect(oauth2_errors.LoginRequired)

    def _remember_and_sign_in(self):
        request = self.request
        try:
            # Validated first: only a request of the Git server to its own redirect URI is kept.
            self.validate_authorization_request(request)
        except OAuthToolkitError as error:
            return self.error_response(error, application=None)
        query = request.META.get("QUERY_STRING", "")
        if len(query) > continuation.MAX_QUERY_LENGTH:
            return self.render_to_response({"error": oauth2_errors.InvalidRequestFatalError()}, status=400)
        binding = continuation.binding_from(request) or continuation.new_binding()
        continue_id = continuation.remember(query, binding)
        response = HttpResponseRedirect(_sign_in_url(request, continue_id))
        continuation.set_binding_cookie(response, request, binding)
        return response

    def _error_redirect(self, error_class):
        """``redirect_uri?error=…&state=…`` for a request that is valid otherwise; an invalid one gets the page."""
        try:
            _scopes, credentials = self.validate_authorization_request(self.request)
        except OAuthToolkitError as error:
            return self.error_response(error, application=None)
        application = get_application_model().objects.get(client_id=credentials["client_id"])
        error = OAuthToolkitError(
            error=error_class(state=credentials.get("state")), redirect_uri=credentials["redirect_uri"]
        )
        return self.error_response(error, application)

    def render_to_response(self, context, **response_kwargs):
        # Errors that must not redirect (unknown client, foreign redirect URI) — a plain page with the OAuth code.
        error = context.get("error")
        if error is not None:
            return _message_page(
                self.request,
                title=FAILED_TITLE,
                text=FAILED_TEXT,
                status=response_kwargs.get("status") or getattr(error, "status_code", 400) or 400,
                error_code=getattr(error, "error", None) or "invalid_request",
            )
        # A consent form would mean the client lost skip_authorization: `ppm_oidc_client --ensure` restores it.
        logger.warning("The Git server client asks for consent; run `manage.py ppm_oidc_client --ensure`")
        return _message_page(
            self.request,
            title=UNAVAILABLE_TITLE,
            text=UNAVAILABLE_TEXT,
            status=503,
            error_code="temporarily_unavailable",
        )


def _is_invalid_client(response):
    if response.status_code == 401:
        return True
    try:
        return json.loads(response.content).get("error") == "invalid_client"
    except (ValueError, AttributeError):
        return False


@method_decorator(csrf_exempt, name="dispatch")
class PpmTokenView(SingleSignOnSwitchMixin, toolkit_views.TokenView):
    # The Git server exchanges codes; refresh tokens stay possible for 1 hour (R1). Everything else — other grants
    # and the device flow, which the toolkit would try to serve here — is refused before any processing.
    allowed_grant_types = ("authorization_code", "refresh_token")

    def post(self, request, *args, **kwargs):
        # R7: only failed client authentications of this address are counted (throttling.py explains why); once too
        # many, the address waits — before any secret is checked again.
        failures = throttling.TokenFailureThrottle(request)
        retry_after = failures.retry_after()
        if retry_after:
            return _oauth_json_error("temporarily_unavailable", 429, headers={"Retry-After": str(retry_after)})
        if request.POST.get("grant_type") not in self.allowed_grant_types:
            return _oauth_json_error("unsupported_grant_type", 400)
        try:
            response = super().post(request, *args, **kwargs)
        finally:
            # After the toolkit's own (shorter) list: this one is what an error report reads.
            request.sensitive_post_parameters = SENSITIVE_PARAMETERS
        if _is_invalid_client(response):
            failures.record_failure()
        return response


@method_decorator(csrf_exempt, name="dispatch")
class PpmUserInfoView(SingleSignOnSwitchMixin, toolkit_views.UserInfoView):
    def _create_userinfo_response(self, request):
        # RFC 9700 §4.3.2: an access token never travels in the URL (it would end up in logs and histories).
        if "access_token" in request.GET:
            return _oauth_json_error("invalid_request", 400)
        try:
            return super()._create_userinfo_response(request)
        finally:
            request.sensitive_post_parameters = SENSITIVE_PARAMETERS


class PpmJwksView(SingleSignOnSwitchMixin, toolkit_views.JwksInfoView):
    """The current signing key and, during a rotation, the previous one (R7) — public parts only."""


class PpmDiscoveryView(SingleSignOnSwitchMixin, View):
    http_method_names = ["get"]
    internal = False

    def get(self, request, *args, **kwargs):
        public = state.issuer()
        back_channel = state.internal_base_url() if self.internal else public
        document = {
            "issuer": public,
            "authorization_endpoint": f"{public}/authorize/",
            "token_endpoint": f"{back_channel}/token/",
            "userinfo_endpoint": f"{back_channel}/userinfo/",
            "jwks_uri": f"{back_channel}/jwks/",
            "scopes_supported": SCOPES_SUPPORTED,
            "response_types_supported": ["code"],
            "response_modes_supported": ["query"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "subject_types_supported": ["public"],
            "id_token_signing_alg_values_supported": ["RS256"],
            "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"],
            "code_challenge_methods_supported": ["S256"],
            "claims_supported": CLAIMS_SUPPORTED,
            "prompt_values_supported": ["none"],
        }
        response = JsonResponse(document)
        if not self.internal:
            response["Access-Control-Allow-Origin"] = "*"
        return response


@method_decorator(never_cache, name="dispatch")
class PpmContinueView(SingleSignOnSwitchMixin, View):
    """R6: ``continue/<id>/`` — once, in the browser that started the sign-in, back to the kept authorization."""

    http_method_names = ["get"]
    throttle_class = throttling.ContinueThrottle

    def get(self, request, continue_token):
        entry = continuation.load(continue_token, continuation.binding_from(request))
        if entry is None:
            # Unknown, expired, used or started in another browser — the same page, nothing is revealed.
            return _expired_page(request)
        if not request.user.is_authenticated:
            if not continuation.note_anonymous_visit(continue_token, entry):
                return _expired_page(request)
            return HttpResponseRedirect(_sign_in_url(request, continue_token))
        if not continuation.consume(continue_token):
            return _expired_page(request)
        return HttpResponseRedirect(f"{state.issuer()}/authorize/?{entry['query']}")
