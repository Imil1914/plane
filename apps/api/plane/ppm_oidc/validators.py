"""G2.2 R3–R5 — the request validator of PPM's OpenID Connect provider (django-oauth-toolkit)."""

from oauth2_provider.oauth2_validators import OAuth2Validator

from plane.ppm_core.permissions import is_ppm_global_admin
from plane.ppm_oidc import login, state

DISCOVERY_CLAIMS = ("sub", "name", "email", "email_verified", "nickname", "preferred_username", "groups")


class PpmOAuth2Validator(OAuth2Validator):
    # ``groups`` is not a standard claim: it is released only with the ``groups`` scope.
    oidc_claim_scope = {**OAuth2Validator.oidc_claim_scope, "groups": "groups"}

    def _load_application(self, client_id, request):
        # R3: exactly one client — the Git server, ``PPM_OIDC_CLIENT_ID``. Any other application that may sit in the
        # OAuth2 tables is refused at every step that loads a client (authorization, client authentication, token).
        if not client_id or client_id != state.configured_client_id():
            return None
        return super()._load_application(client_id, request)

    def get_additional_claims(self, request):
        """R4: ``sub`` (added by the toolkit) = the PPM user id; the Git server name comes from the access module."""
        user = request.user
        claims = {
            "name": state.display_name(user),
            "email": user.email,
            # The real state in PPM (review ruling on R4): Forgejo does not read it, a future client might trust it.
            "email_verified": bool(getattr(user, "is_email_verified", False)),
            # For reference only: rights on the Git server are applied by the access synchronisation (R14).
            "groups": [state.PPM_ADMINS_GROUP] if is_ppm_global_admin(user=user) else [],
        }
        username = login.git_server_username(user)
        if username:
            claims["nickname"] = username
            claims["preferred_username"] = username
        return claims

    def get_discovery_claims(self, request):
        return list(DISCOVERY_CLAIMS)

    def validate_silent_login(self, request):
        # ``prompt=none`` reaches the validation only with a PPM session: an anonymous one is answered
        # ``login_required`` by the authorization view first.
        return True

    def validate_silent_authorization(self, request):
        # The Git server is a trusted client (``skip_authorization``): there is no consent to ask for.
        return True

    def validate_bearer_token(self, token, scopes, request):
        if not super().validate_bearer_token(token, scopes, request):
            return False
        application = getattr(getattr(request, "access_token", None), "application", None)
        if application is not None and application.client_id == state.configured_client_id():
            if state.user_may_sign_in(request.user):
                return True
        # R3: only tokens of the Git server client; R5: a person switched off in PPM gets nothing more, even from a
        # token a bulk update left in the table.
        self._set_oauth2_error_on_request(request, None, scopes)
        return False

    def validate_refresh_token(self, refresh_token, client, request, *args, **kwargs):
        if not super().validate_refresh_token(refresh_token, client, request, *args, **kwargs):
            return False
        return state.user_may_sign_in(request.user)
