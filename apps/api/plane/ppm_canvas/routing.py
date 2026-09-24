from django.urls import re_path

from .consumers import PpmCanvasPresenceConsumer


UUID_PATTERN = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"

websocket_urlpatterns = [
    re_path(
        rf"^ws/ppm/v1/workspaces/(?P<workspace_id>{UUID_PATTERN})/projects/"
        rf"(?P<project_id>{UUID_PATTERN})/canvas/boards/(?P<board_id>{UUID_PATTERN})/presence/$",
        PpmCanvasPresenceConsumer.as_asgi(),
        name="ppm-canvas-presence",
    )
]
