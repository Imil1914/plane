from django.conf import settings


def brain_enabled():
    return bool(getattr(settings, "PPM_BRAIN_ENABLED", True))


def answers_enabled():
    return brain_enabled() and bool(getattr(settings, "PPM_BRAIN_ANSWERS_ENABLED", True))


def graph_enabled():
    return brain_enabled() and bool(getattr(settings, "PPM_BRAIN_GRAPH_ENABLED", True))


def agents_enabled():
    return brain_enabled() and bool(getattr(settings, "PPM_AGENTS_ENABLED", True))


def agents_write_enabled():
    return agents_enabled() and bool(getattr(settings, "PPM_AGENTS_WRITE_ENABLED", False))
