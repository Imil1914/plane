"""RC-F1 (D-2): версия источника задачи Plane для Холста и Мозга и текущие исполнители задачи.

Версия — отпечаток содержимого задачи, а не `issue.updated_at`. Время двигает не только правка: штатная задача Plane
`issue_activity` после каждого изменения, комментария, ссылки или связи задачи делает `issue.updated_at = now();
save()`. С версией-временем живая карточка Холста устаревала через ~0,1 с после собственного сохранения (второе
изменение за загрузку страницы → 409), а Мозг переиндексировал задачу на каждый комментарий.

Формат — `wi1:<поля>.<описание>`, два отпечатка HMAC-SHA256 по 24 hex (53 символа; колонка
`PpmCanvasBinding.source_version` и поле PATCH — до 64):
- `<поля>` — то, что карточка показывает и меняет: название, статус, приоритет, текущие исполнители, начало и срок,
  жизненный цикл (в архиве / удалена / черновик); плюс id задачи, чтобы версии разных задач не совпадали;
- `<описание>` — текст описания (`description_stripped` без различий в пробелах) — его индексирует Мозг.
Отпечаток ключевой (`salted_hmac`, ключ — `SECRET_KEY`): версия недоступной задачи остаётся в привязке и уходит
всем зрителям доски (`serialize_missing_work_item`), и простой хэш позволил бы ограниченному гостю офлайн проверять
догадки о названии или описании чужой задачи. Смена `SECRET_KEY` один раз меняет все версии (открытые карточки
получат по одному 409, Мозг переиндексирует задачи при ближайшей сверке) — как она же сбрасывает сессии.

Кто как сравнивает:
- правка с карточки (`services.update_work_item`) — только `<поля>` (`work_item_version_matches`): описание на
  карточке не видно и с неё не меняется, конфликт — только если поля карточки изменили в другом месте;
- Мозг (`ppm_brain.adapters.load_work_item`) и клиентское «изменился после поиска» (`isCitationStale`, R17:
  версия цитаты Мозга против версии привязки Холста) — строку целиком, поэтому Мозг берёт версию отсюда же.
Свойства связанных объектов (название и цвет статуса, имена и аватары исполнителей) в версию не входят: это не поля
задачи, с карточки они не меняются, а отображение и так перечитывается при каждом чтении проекции.

Совместимость (R-F1d): версия старого формата — ISO-время `updated_at` из вкладки, открытой до обновления (сервер
всегда отдаёт версию при чтении проекции, а сохранённая в снимке доски версия предусловием правки не служит). Её
принимаем, только если она равна текущему `updated_at` — правило прежнего сервера: с момента чтения задачу не
сохраняли вовсе. Иначе — 409 с версией нового формата в `current_source_version`: клиент по 409 перечитывает
карточки (`editor.tsx`, `refreshWorkItems`), следующее изменение проходит, отклонённое не записано. Выяснить,
менялись ли после того времени именно поля карточки, надёжно нельзя: единственная история — `IssueActivity`, её
пишет асинхронная задача, и в ней же лежит собственная правка вкладки, сделанная до обновления.
"""

import json
import re
from datetime import date, datetime

from django.db.models import Prefetch
from django.utils.crypto import salted_hmac

from plane.db.models import IssueAssignee


WORK_ITEM_VERSION_PREFIX = "wi1:"
DIGEST_LENGTH = 24
_DIGEST_SALT = "plane.ppm_canvas.work_item_version.wi1"
_VERSION_PATTERN = re.compile(
    rf"^{re.escape(WORK_ITEM_VERSION_PREFIX)}(?P<fields>[0-9a-f]{{{DIGEST_LENGTH}}})\.[0-9a-f]{{{DIGEST_LENGTH}}}$"
)


def current_assignees_prefetch():
    """Для `prefetch_related`: текущие исполнители — строки `IssueAssignee` (менеджер модели отбрасывает мягко
    удалённые) вместе с пользователем, одним запросом на всю выборку задач."""
    return Prefetch("issue_assignee", queryset=IssueAssignee.objects.select_related("assignee"))


def current_assignees(issue):
    """Текущие исполнители задачи — как `assignee_ids` у Plane. `issue.assignees` (M2M через `IssueAssignee`) мягко
    удалённые строки не отбрасывает: снятый в Plane исполнитель оставался бы на карточке, в индексе Мозга, в журнале
    правки и в версии. Читает предзагрузку `current_assignees_prefetch()`, без неё — один запрос."""
    prefetched = getattr(issue, "_prefetched_objects_cache", {}).get("issue_assignee")
    rows = (
        prefetched
        if prefetched is not None
        else IssueAssignee.objects.filter(issue_id=issue.id).select_related("assignee")
    )
    return [row.assignee for row in rows]


def _digest(payload):
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return salted_hmac(_DIGEST_SALT, encoded, algorithm="sha256").hexdigest()[:DIGEST_LENGTH]


def _calendar_day(value):
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value) if value else None


def work_item_source_version(issue, *, assignee_ids=None):
    """Версия источника задачи (формат и правила — в описании модуля). `assignee_ids` — уже прочитанные текущие
    исполнители (чтобы не читать их второй раз); по умолчанию — `current_assignees(issue)`."""
    if assignee_ids is None:
        assignee_ids = [user.id for user in current_assignees(issue)]
    fields = {
        "id": str(issue.id),
        "name": issue.name or "",
        "state_id": str(issue.state_id) if issue.state_id else None,
        "priority": issue.priority,
        "assignee_ids": sorted({str(value) for value in assignee_ids}),
        "start_date": _calendar_day(issue.start_date),
        "target_date": _calendar_day(issue.target_date),
        "archived": issue.archived_at is not None,
        "deleted": issue.deleted_at is not None,
        "draft": bool(issue.is_draft),
    }
    description = " ".join(str(issue.description_stripped or "").split())
    return f"{WORK_ITEM_VERSION_PREFIX}{_digest(fields)}.{_digest(description)}"


def _card_fields_digest(version):
    match = _VERSION_PATTERN.match(version) if isinstance(version, str) else None
    return match.group("fields") if match else None


def work_item_version_matches(client_version, *, issue, current_version):
    """Предусловие правки с карточки. Версия нового формата — совпадение `<поля>` с текущей; иначе (версия-время
    старого формата, R-F1d) — правило прежнего сервера: равна текущему `updated_at`."""
    client_fields = _card_fields_digest(client_version)
    if client_fields is not None:
        return client_fields == _card_fields_digest(current_version)
    return bool(client_version) and issue.updated_at is not None and client_version == issue.updated_at.isoformat()
