import pytest

from .realtime_helpers import RecordingLayer, build_world


@pytest.fixture
def world(db):
    return build_world()


@pytest.fixture
def recorded(monkeypatch):
    """Every group message published after commit, instead of a real channel layer."""
    layer = RecordingLayer()
    monkeypatch.setattr("plane.ppm_realtime.publish.get_channel_layer", lambda *args, **kwargs: layer)
    return layer
