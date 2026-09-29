"""UX2.1 — how many event sockets one person may hold open at once (all API processes together).

A sorted set in the Redis cache per person: member — the socket, score — until when it counts. A socket renews its
slot on every access re-check and gives it back on close; a process that died without closing loses its slots after
``SLOT_TTL_SECONDS``, so a crash never locks a person out for long. Redis trouble lets the socket in (fail open): the
limit guards against abuse, it must not take the channel down with the cache.
"""

import logging
import time

from django_redis import get_redis_connection


logger = logging.getLogger("plane.api")

PPM_REALTIME_MAX_SOCKETS_PER_USER = 10
# Four access re-checks (12–15 s apart) may be missed before a slot is given up.
SLOT_TTL_SECONDS = 60


def _key(user_id):
    return f"ppm:realtime:sockets:{user_id}"


def claim_socket_slot(user_id, connection_id):
    """Take a slot for the socket; False when the person already has the maximum open."""
    try:
        client = get_redis_connection("default")
        key = _key(user_id)
        now = time.time()
        pipeline = client.pipeline()
        pipeline.zremrangebyscore(key, "-inf", now)
        pipeline.zadd(key, {connection_id: now + SLOT_TTL_SECONDS})
        pipeline.zcard(key)
        pipeline.expire(key, SLOT_TTL_SECONDS)
        _, _, open_sockets, _ = pipeline.execute()
        if open_sockets > PPM_REALTIME_MAX_SOCKETS_PER_USER:
            client.zrem(key, connection_id)
            return False
        return True
    except Exception as exc:
        _log_failure("PPM realtime socket slot could not be claimed", exc)
        return True


def renew_socket_slot(user_id, connection_id):
    try:
        client = get_redis_connection("default")
        key = _key(user_id)
        pipeline = client.pipeline()
        pipeline.zadd(key, {connection_id: time.time() + SLOT_TTL_SECONDS})
        pipeline.expire(key, SLOT_TTL_SECONDS)
        pipeline.execute()
    except Exception as exc:
        _log_failure("PPM realtime socket slot could not be renewed", exc)


def release_socket_slot(user_id, connection_id):
    try:
        get_redis_connection("default").zrem(_key(user_id), connection_id)
    except Exception as exc:
        _log_failure("PPM realtime socket slot could not be released", exc)


def _log_failure(message, exc):
    # Without the exception text: a Redis error may carry the connection address and password.
    logger.warning(message, extra={"error_type": type(exc).__name__})
