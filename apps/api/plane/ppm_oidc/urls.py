"""G2.2 R2 — the endpoints of PPM's OpenID Connect provider, mounted at ``/auth/oidc/`` by ``plane/urls.py``.

Only what the Git server needs is published: no logout, revocation, introspection, client registration or client
management of the toolkit. The route names are those of django-oauth-toolkit in its namespace ``oauth2_provider`` —
the toolkit reverses them.
"""

from django.urls import path, re_path

from plane.ppm_oidc import views

app_name = "oauth2_provider"

urlpatterns = [
    path("authorize/", views.PpmAuthorizationView.as_view(), name="authorize"),
    path("token/", views.PpmTokenView.as_view(), name="token"),
    path("userinfo/", views.PpmUserInfoView.as_view(), name="user-info"),
    path("jwks/", views.PpmJwksView.as_view(), name="jwks-info"),
    re_path(
        r"^\.well-known/openid-configuration/?$",
        views.PpmDiscoveryView.as_view(),
        name="oidc-connect-discovery-info",
    ),
    # For Forgejo inside the bundle; the proxy answers 404 to it from outside (line S3).
    re_path(
        r"^internal/\.well-known/openid-configuration/?$",
        views.PpmDiscoveryView.as_view(internal=True),
        name="ppm-oidc-internal-discovery",
    ),
    # ``continue_token``: the request log masks URL arguments named like a token (plane.middleware.logger).
    path("continue/<str:continue_token>/", views.PpmContinueView.as_view(), name="ppm-oidc-continue"),
]
