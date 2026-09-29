from django.urls import path

from .admin_views import (
    PpmAdminAccessView,
    PpmAdminAuditListView,
    PpmAdminProjectEnterView,
    PpmAdminProjectListView,
    PpmAdminReauthenticateView,
    PpmAdminUserListView,
    PpmAdminUserResumeView,
    PpmAdminUserSuspendView,
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
    path(
        "admin/users/<uuid:user_id>/suspend/",
        PpmAdminUserSuspendView.as_view(),
        name="ppm-admin-user-suspend",
    ),
    path(
        "admin/users/<uuid:user_id>/resume/",
        PpmAdminUserResumeView.as_view(),
        name="ppm-admin-user-resume",
    ),
    path("admin/audit/", PpmAdminAuditListView.as_view(), name="ppm-admin-audit"),
    path("admin/reauthenticate/", PpmAdminReauthenticateView.as_view(), name="ppm-admin-reauthenticate"),
]
