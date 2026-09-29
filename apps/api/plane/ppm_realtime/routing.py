from django.urls import re_path

from .consumers import PpmProjectEventsConsumer


# Plane workspace slugs are Django slugs.
WORKSPACE_SLUG_PATTERN = r"[-a-zA-Z0-9_]+"

websocket_urlpatterns = [
    re_path(
        rf"^ws/ppm/v1/workspaces/(?P<workspace_slug>{WORKSPACE_SLUG_PATTERN})/events/$",
        PpmProjectEventsConsumer.as_asgi(),
        name="ppm-project-events",
    )
]
