from django.urls import path

from .views import PpmCanvasView


urlpatterns = [
    path(
        "workspaces/<uuid:workspace_id>/projects/<uuid:project_id>/canvas/",
        PpmCanvasView.as_view(),
        name="ppm-project-canvas",
    )
]
