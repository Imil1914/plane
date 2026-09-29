"""G2.2 R5, R9 — oauthlib's OpenID Connect server with PPM's step between a verified code and the tokens."""

from oauthlib.oauth2.rfc6749 import errors
from oauthlib.openid import Server

from plane.ppm_oidc import login, state


class PpmOidcServer(Server):
    def __init__(self, request_validator, *args, **kwargs):
        super().__init__(request_validator, *args, **kwargs)
        self.ppm_request_validator = request_validator
        # oauthlib hands no custom validators to the authorization-code grants of its OpenID server, so the step is
        # appended to their ``post_token`` lists: those run after the client, the code, PKCE and the redirect URI are
        # verified and before any token (or ID token) is created. ``openid_connect_auth`` proxies to its own OAuth2
        # grant, hence both.
        for grant in (self.auth_grant, self.openid_connect_auth):
            grant.custom_validators.post_token.append(self._before_tokens_for_git_server)

    def _before_tokens_for_git_server(self, request):
        user = request.user
        if not state.user_may_sign_in(user):
            # R5: switched off (or a bot, or without e-mail) between the authorization and the exchange.
            self._forget_code(request)
            raise errors.InvalidGrantError(request=request)
        try:
            login.prepare_git_server_login(user)
        except login.GitServerLoginRejected:
            # R9: no account on the Git server — no sign-in. The Git server learns only ``server_error``.
            self._forget_code(request)
            raise errors.ServerError(request=request, status_code=500) from None

    def _forget_code(self, request):
        # A code whose exchange was refused must not work later.
        try:
            self.ppm_request_validator.invalidate_authorization_code(request.client_id, request.code, request)
        except errors.OAuth2Error:
            pass
