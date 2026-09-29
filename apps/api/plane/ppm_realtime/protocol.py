"""UX2.1 — the fixed protocol of the project events channel (docs/superpowers/plans/2026-09-29-ux21-realtime/plan.md).

Client → server: ``{"type": "subscribe", "project_ids": [...]}``, ``{"type": "unsubscribe", "project_ids": [...]}``,
``{"type": "ping"}``.
Server → client: ``{"type": "subscribed", "project_ids": [...], "denied": [...]}``, ``{"type": "event", "project_id",
"entity", "action", "ids", "seq", "at"}``, ``{"type": "access_revoked", "project_id"}``, ``{"type": "pong"}``.
Close codes: 4401 not signed in, 4403 no access to the workspace, 4404 the channel is off (flag or no channel layer),
4429 too many subscriptions or messages, 1009 message too big, 1011 internal error.
"""

import uuid


ENTITIES = frozenset({"issue", "cycle", "module", "project"})
ACTIONS = frozenset({"created", "updated", "deleted", "moved"})
# Inside one coalescing window an id keeps its strongest action. Every action but «updated» makes the client re-read
# its lists, so whatever happened last is fetched anyway.
ACTION_STRENGTH = {"updated": 0, "moved": 1, "created": 2, "deleted": 3}
EVENT_ACTION_ORDER = ("created", "updated", "moved", "deleted")

# Internal message between the publisher and the sockets (``type`` → ``PpmProjectEventsConsumer.ppm_project_event``).
GROUP_MESSAGE_TYPE = "ppm.project.event"

CLOSE_NOT_AUTHENTICATED = 4401
CLOSE_FORBIDDEN = 4403
CLOSE_UNAVAILABLE = 4404
CLOSE_TOO_MANY = 4429
CLOSE_MESSAGE_TOO_BIG = 1009
CLOSE_INTERNAL_ERROR = 1011


def project_events_group_name(project_id):
    return f"ppm-events-project-{uuid.UUID(str(project_id))}"
