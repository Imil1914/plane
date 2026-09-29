from django.conf import settings


def realtime_events_enabled():
    """UX2.1 U5: ``PPM_REALTIME_EVENTS_ENABLED`` (on by default). Off — the socket refuses with 4404 and nothing is
    published; the web client stays on the 30-second refresh of line S."""
    return bool(getattr(settings, "PPM_REALTIME_EVENTS_ENABLED", True))
