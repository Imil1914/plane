"""UX2.1 — holding realtime publications back and sending them merged.

A cascade of saves (``soft_delete_related_objects`` of a work item: every link, assignee, label and sub-item saved one
by one) would otherwise publish a message per row. Inside ``publication_batch`` the publications are merged; one
message per project goes out when the outermost batch ends (after commit, as always).

No model imports here: ``plane.bgtasks.deletion_task`` is imported while ``plane.db.models`` loads.
"""

import contextvars
import functools
from contextlib import contextmanager


_held = contextvars.ContextVar("ppm_realtime_publication_batch", default=None)


def held_publications():
    """The publications of the current batch (project id → pending changes), or None outside a batch."""
    return _held.get()


@contextmanager
def publication_batch():
    if _held.get() is not None:
        # Inside an outer batch (the cascade calls itself): the outer one sends everything.
        yield
        return
    held = {}
    token = _held.set(held)
    try:
        yield
    finally:
        _held.reset(token)
        if held:
            from .publish import schedule_held

            schedule_held(held)


def in_publication_batch(func):
    """``publication_batch`` around every call of ``func``."""

    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        with publication_batch():
            return func(*args, **kwargs)

    return wrapper
