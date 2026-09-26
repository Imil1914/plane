"""AF2.2 S3 — личная отметка «просмотрено» на доске (для ленты «Что изменилось»).

Одна строка на пару (доска, пользователь). Время и версия берутся на сервере: клиент не может сдвинуть свою отметку
в прошлое или будущее, а два одновременных «Отметить просмотренным» из разных вкладок сходятся в одну строку
(вставка с обновлением по уникальному ключу, без гонки get_or_create).
"""

from django.utils import timezone

from .models import PpmCanvasBoardUserState


def serialize_board_user_state(state):
    if state is None:
        return {"seen_at": None, "seen_version": None}
    return {"seen_at": state.seen_at.isoformat(), "seen_version": state.seen_version}


def get_board_user_state(*, board, user):
    return serialize_board_user_state(PpmCanvasBoardUserState.objects.filter(board=board, user=user).first())


def mark_board_seen(*, board, user):
    state = PpmCanvasBoardUserState(
        board=board,
        user=user,
        seen_at=timezone.now(),
        seen_version=board.current_version,
    )
    PpmCanvasBoardUserState.objects.bulk_create(
        [state],
        update_conflicts=True,
        unique_fields=["board", "user"],
        update_fields=["seen_at", "seen_version", "updated_at"],
    )
    return serialize_board_user_state(state)
