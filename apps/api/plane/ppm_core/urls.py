from django.urls import path

from .admin_views import (
    PpmAdminAccessView,
    PpmAdminAuditListView,
    PpmAdminProjectEnterView,
    PpmAdminProjectListView,
    PpmAdminReauthenticateView,
    PpmAdminUserListView,
)


urlpatterns = [
    path("admin/access/", PpmAdminAccessView.as_view(), name="ppm-admin-access"),
    path("admin/projects/", PpmAdminProjectListView.as_view(), name="ppm-admin-projects"),
    path(
        "admin/projects/<uuid:project_id>/enter/",
        PpmAdminProjectEnterView.as_view(),
        name="ppm-admin-project-enter",
    ),
    path("admin/users/", PpmAdminUserListView.as_view(), name="ppm-admin-users"),
    path("admin/audit/", PpmAdminAuditListView.as_view(), name="ppm-admin-audit"),
    path("admin/reauthenticate/", PpmAdminReauthenticateView.as_view(), name="ppm-admin-reauthenticate"),
]
