"""AF2.2 S2 — лента «Что изменилось» для доски Холста.

Лента собирается по запросу из существующих данных (решение R4: без отдельного журнала событий):

- Plane `IssueActivity` — статус, исполнители, срок, приоритет, название и связи задач, привязанных к доске
  (активные привязки), и задач спринта, если в текущем снимке есть рамка спринта (`group` с `map.role = "sprint"`);
- `PpmGitLink`/`PpmGitObject` — PR этих задач: «открыт» (первое появление PR в PPM) и «влит» (время слияния у
  провайдера, `provider_merged_at`);
- `PpmVaultVersion` — новые версии файлов Хранилища, привязанных к доске;
- снимки доски `PpmCanvasVersion` — карточки PPM по `created_at`/`updated_at` узла, нативные фигуры tldraw — «добавлено»
  по сравнению с версией доски на момент `since`; перемещение изменением не считается. Время и автор фигуры без своей
  метки времени и автор правки карточки — из отметок версий (`added_shape_ids`, `changed_shape_ids`, пишутся при
  сохранении); для версий, сохранённых до S2a, — поиск по истории без автора. Первая сохранённая версия доски — её
  исходное содержимое (собранная карта, копия доски): её фигуры «добавленными» не бывают никогда (M-1, `_board_events`).

Спринт (M-7): задачи спринта и режим «с начала спринта» (его `since` — дата начала спринта — задаёт клиент) берутся по
**всем** рамкам спринта в сохранённом снимке доски (не больше `MAX_SPRINT_FRAMES` = 10, на любой глубине), а шапка
клиента (название и начало спринта) — по первой рамке верхнего уровня. Если на доске две карты (например, вставлена
копия чужой карты), лента покажет задачи обоих спринтов, а шапка — один из них; это решение, а не расхождение.

Видимость: задачи — `get_visible_work_items` (ограниченный гость видит только свои); PR — только через видимые задачи;
файлы — только активные записи Хранилища с проверенной версией; идентификатор связанной задачи, которую пользователь
не видит, не раскрывается; авторы — только участники рабочего пространства. Содержимое (текст заметок и файлов,
описания) в ленту не попадает.

Число запросов не зависит от числа событий, задач и фигур: по одному на источник, по одному на отметки версий, один на
авторов и — только для истории до S2a — не больше `SHAPE_TIME_PROBE_BUDGET` коротких запросов к версиям доски.
"""

import json
import re
import uuid
from collections import defaultdict
from datetime import timedelta
from datetime import timezone as dt_timezone

from django.db import connection
from django.db.models import Max, Min, Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from plane.db.models import CycleIssue, IssueActivity, User
from plane.ppm_git.models import PpmGitLink, PpmGitLinkStatus, PpmGitObjectType, PpmGitRepositoryStatus
from plane.ppm_vault.models import PpmVaultEntryStatus, PpmVaultVersion, PpmVaultVersionStatus
from plane.utils.issue_relation_mapper import get_actual_relation

from .models import PpmCanvasBinding, PpmCanvasBindingStatus, PpmCanvasEntityType, PpmCanvasVersion
from .services import get_visible_work_items


PPM_CANVAS_CHANGES_MAX_DAYS = 30
PPM_NODE_SHAPE_TYPE = "ppm-canvas-node"
# Как в клиентском счётчике объектов (`canvas-toolkit-model.ts`, UNCOUNTED_SHAPE_TYPES) плюс tldraw-группа:
# связи, линии и штрихи пера — не «добавленный объект», группировка существующих фигур — тоже.
UNTRACKED_NATIVE_SHAPE_TYPES = frozenset({"arrow", "line", "draw", "highlight", "group"})
# Поле IssueActivity → (вид события, поле в detail).
WORK_ITEM_FIELD_KINDS = {
    "state": ("work_item.state", "state"),
    "assignees": ("work_item.assignees", "assignees"),
    "target_date": ("work_item.due", "due_date"),
    "priority": ("work_item.priority", "priority"),
    "name": ("work_item.name", "name"),
}
# Значения IssueActivity.field для связей (bgtasks/issue_activities_task.py: create/delete_issue_relation_activity).
RELATION_FIELDS = frozenset(
    {
        "relates_to",
        "duplicate",
        "blocked_by",
        "blocking",
        "start_before",
        "start_after",
        "finish_before",
        "finish_after",
        "implemented_by",
        "implements",
    }
)
MAX_SPRINT_FRAMES = 10
GIT_LINK_SCAN_LIMIT = 2000
SHAPE_TIME_PROBE_BUDGET = 12
MAX_NODE_JSON_CHARS = 200_000
MAX_TEXT_CHARS = 255
MAX_TITLE_CHARS = 160
DATE_PREFIX = re.compile(r"^\d{4}-\d{2}-\d{2}")

# Id фигур одной версии доски — без передачи самого снимка. Правило id (`record.id`, иначе ключ записи) — как в
# schema.canvas_snapshot_shape_ids (там — все места, где оно повторено); менять вместе.
VERSION_SHAPE_IDS_SQL = """
    SELECT COALESCE(record.value ->> 'id', record.key)
    FROM ppm_canvas_versions AS saved
    CROSS JOIN LATERAL jsonb_each(
        CASE
            WHEN jsonb_typeof(saved.snapshot_json -> 'document' -> 'store') = 'object'
            THEN saved.snapshot_json -> 'document' -> 'store'
            ELSE '{}'::jsonb
        END
    ) AS record(key, value)
    WHERE saved.board_id = %s
      AND saved.version = %s
      AND jsonb_typeof(record.value) = 'object'
      AND record.value ->> 'typeName' = 'shape'
"""

# AF2.2 S2a: версии из (low, current], отметившие фигуру, — одним запросом на все фигуры; версии до S2a (NULL) не
# участвуют. Имя столбца и порядок подставляются только из констант ниже. GIN-индекса на отметках нет намеренно (см.
# `_version_marks`).
_VERSION_MARK_SQL = """
    SELECT DISTINCT ON (mark.shape_id) mark.shape_id, saved.created_at, saved.created_by
    FROM ppm_canvas_versions AS saved
    CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(saved.{column}) = 'array' THEN saved.{column} ELSE '[]'::jsonb END
    ) AS mark(shape_id)
    WHERE saved.board_id = %s
      AND saved.version > %s
      AND saved.version <= %s
      AND saved.{column} ?| %s::text[]
      AND mark.shape_id = ANY(%s::text[])
    ORDER BY mark.shape_id, saved.version {order}
"""
# «Добавлено» — самая ранняя версия после `since`, где фигура появилась.
FIRST_ADDED_SQL = _VERSION_MARK_SQL.format(column="added_shape_ids", order="ASC")
# «Изменено» — самая поздняя версия, сменившая `updated_at` карточки: она сохранила ту правку, о которой событие.
LAST_CHANGED_SQL = _VERSION_MARK_SQL.format(column="changed_shape_ids", order="DESC")


def get_board_changes(*, board, project, user, since, limit):
    until = timezone.now()
    truncated = False
    floor = until - timedelta(days=PPM_CANVAS_CHANGES_MAX_DAYS)
    if since < floor:
        since, truncated = floor, True
    since = min(since, until)
    # Связь задач пишется в IssueActivity двумя строками (по одной на каждую задачу) и склеивается в одно событие,
    # поэтому из каждого источника берётся вдвое больше строк, чем нужно событий.
    fetch = 2 * limit + 1

    current = (
        PpmCanvasVersion.objects.filter(board=board, version=board.current_version).first()
        if board.current_version
        else None
    )
    shapes = _shape_records(current.snapshot_json) if current else {}
    nodes = {
        shape_id: _parse_node(record)
        for shape_id, record in shapes.items()
        if record.get("type") == PPM_NODE_SHAPE_TYPE
    }
    shapes_by_entity = _bound_shapes(board)
    visible = get_visible_work_items(project=project, user=user, include_inactive=True).filter(
        deleted_at__isnull=True,
        is_draft=False,
    )
    issues = _relevant_work_items(
        visible=visible,
        project=project,
        bound_ids=[
            entity_id
            for entity_type, entity_id in shapes_by_entity
            if entity_type == PpmCanvasEntityType.WORK_ITEM.value
        ],
        cycle_ids=_sprint_cycle_ids(nodes),
    )

    events = []
    work_item_events, capped = _work_item_events(
        project=project,
        issues=issues,
        visible=visible,
        shapes_by_entity=shapes_by_entity,
        since=since,
        until=until,
        fetch=fetch,
    )
    events.extend(work_item_events)
    truncated = truncated or capped
    git_events, capped = _git_events(
        project=project,
        issues=issues,
        shapes_by_entity=shapes_by_entity,
        since=since,
        until=until,
    )
    events.extend(git_events)
    truncated = truncated or capped
    vault_events, capped = _vault_events(
        project=project,
        shapes_by_entity=shapes_by_entity,
        since=since,
        until=until,
        fetch=fetch,
    )
    events.extend(vault_events)
    truncated = truncated or capped
    events.extend(_board_events(board=board, current=current, shapes=shapes, nodes=nodes, since=since, until=until))

    events.sort(key=lambda event: (event["occurred_at"], event["id"]), reverse=True)
    if len(events) > limit:
        events, truncated = events[:limit], True
    _resolve_authors(events, workspace_id=project.workspace_id)
    return {
        "since": since.isoformat(),
        "until": until.isoformat(),
        "items": [_serialize_event(event) for event in events],
        "truncated": truncated,
    }


def _shape_records(snapshot):
    """Записи фигур снимка по id. Правило id — как в schema.canvas_snapshot_shape_ids (`record.id`, иначе ключ записи);
    менять вместе с ним и с `VERSION_SHAPE_IDS_SQL`."""
    document = snapshot.get("document") if isinstance(snapshot, dict) else None
    store = document.get("store") if isinstance(document, dict) else None
    if not isinstance(store, dict):
        return {}
    return {
        str(record.get("id", record_id)): record
        for record_id, record in store.items()
        if isinstance(record, dict) and record.get("typeName") == "shape"
    }


def _parse_node(record):
    props = record.get("props")
    raw = props.get("node") if isinstance(props, dict) else None
    if not isinstance(raw, str) or len(raw) > MAX_NODE_JSON_CHARS:
        return None
    try:
        node = json.loads(raw)
    except ValueError:
        return None
    return node if isinstance(node, dict) else None


def _sprint_cycle_ids(nodes):
    """Спринты всех рамок спринта снимка, до `MAX_SPRINT_FRAMES` (M-7: все рамки, а не первая, как в шапке клиента)."""
    cycle_ids = set()
    for node in nodes.values():
        if not node or node.get("kind") != "group":
            continue
        config = node.get("map")
        if not isinstance(config, dict) or config.get("role") != "sprint":
            continue
        try:
            cycle_ids.add(uuid.UUID(str(config.get("cycle_id"))))
        except ValueError:
            continue
        if len(cycle_ids) >= MAX_SPRINT_FRAMES:
            break
    return cycle_ids


def _bound_shapes(board):
    shapes = defaultdict(list)
    bindings = (
        PpmCanvasBinding.objects.filter(board=board, status=PpmCanvasBindingStatus.ACTIVE)
        .order_by("created_at", "id")
        .values_list("shape_id", "entity_type", "entity_id")
    )
    for shape_id, entity_type, entity_id in bindings:
        shapes[(str(entity_type), entity_id)].append(shape_id)
    return shapes


def _shapes_for(shapes_by_entity, entity_type, entity_id):
    return list(shapes_by_entity.get((entity_type.value, entity_id), ()))


def _merge_unique(first, second):
    merged = list(first)
    merged.extend(item for item in second if item not in merged)
    return merged


def _relevant_work_items(*, visible, project, bound_ids, cycle_ids):
    scopes = []
    if bound_ids:
        scopes.append(Q(id__in=bound_ids))
    if cycle_ids:
        sprint_items = CycleIssue.objects.filter(
            workspace_id=project.workspace_id,
            project_id=project.id,
            cycle_id__in=cycle_ids,
            cycle__deleted_at__isnull=True,
        ).values("issue_id")
        scopes.append(Q(id__in=sprint_items))
    if not scopes:
        return {}
    scope = scopes[0]
    for extra in scopes[1:]:
        scope |= extra
    return {issue.id: issue for issue in visible.filter(scope).only("id", "sequence_id", "name")}


def _clean_text(value, limit=MAX_TEXT_CHARS):
    if value is None:
        return None
    text = str(value).strip()
    return text[:limit] or None


def _clean_date(value):
    text = _clean_text(value)
    return text[:10] if text and DATE_PREFIX.match(text) else None


def _display_name(user):
    return (
        user.display_name or " ".join(part for part in (user.first_name, user.last_name) if part).strip() or "Участник"
    )


def _user_actor(user):
    return {"id": str(user.id), "display_name": _display_name(user)} if user else None


def _identifier(project, issue):
    return f"{project.identifier}-{issue.sequence_id}"


def _work_item_entity(project, issue):
    return {
        "type": "work_item",
        "id": str(issue.id),
        "identifier": _identifier(project, issue),
        "title": _clean_text(issue.name) or "",
    }


def _relation_other(row):
    return _clean_text(row.new_value if row.verb == "updated" else row.old_value)


def _visible_identifiers(rows, *, project, visible):
    prefix = f"{project.identifier}-"
    sequences = set()
    for row in rows:
        other = _relation_other(row) if row.field in RELATION_FIELDS else None
        if other and other.startswith(prefix) and other[len(prefix) :].isdigit():
            sequences.add(int(other[len(prefix) :]))
    if not sequences:
        return set()
    found = visible.filter(sequence_id__in=sequences).values_list("sequence_id", flat=True)
    return {f"{prefix}{sequence}" for sequence in found}


def _work_item_events(*, project, issues, visible, shapes_by_entity, since, until, fetch):
    if not issues:
        return [], False
    rows = list(
        IssueActivity.objects.filter(
            workspace_id=project.workspace_id,
            project_id=project.id,
            issue_id__in=list(issues),
            field__in=[*WORK_ITEM_FIELD_KINDS, *RELATION_FIELDS],
            verb__in=("updated", "deleted"),
            created_at__gt=since,
            created_at__lte=until,
        )
        .select_related("actor")
        .order_by("-created_at", "-id")[:fetch]
    )
    visible_others = _visible_identifiers(rows, project=project, visible=visible)
    events = []
    relation_groups = defaultdict(list)
    for row in rows:
        issue = issues[row.issue_id]
        if row.field in RELATION_FIELDS:
            other = _relation_other(row)
            moment = row.epoch if row.epoch is not None else row.created_at.replace(microsecond=0).timestamp()
            key = (
                (row.verb, moment, get_actual_relation(row.field), frozenset({_identifier(project, issue), other}))
                if other
                else ("single", row.id)
            )
            relation_groups[key].append(row)
            continue
        kind, detail_field = WORK_ITEM_FIELD_KINDS[row.field]
        clean = _clean_date if row.field == "target_date" else _clean_text
        events.append(
            {
                "id": f"{kind}:{row.id}",
                "kind": kind,
                "occurred_at": row.created_at,
                "actor": _user_actor(row.actor),
                "entity": _work_item_entity(project, issue),
                "shape_ids": _shapes_for(shapes_by_entity, PpmCanvasEntityType.WORK_ITEM, issue.id),
                "detail": {"field": detail_field, "old": clean(row.old_value), "new": clean(row.new_value)},
            }
        )
    for group in relation_groups.values():
        # Обе строки одной связи дают одно событие с фигурами обеих задач. Главная — первая записанная строка: Plane
        # пишет её для задачи, где связь изменили, а у второй строки удаления поле start_*/finish_*/implements не
        # обращено (неверное направление). id события — id этой строки, устойчив между опросами.
        primary = min(group, key=lambda row: (row.created_at, row.id))
        issue = issues[primary.issue_id]
        other = _relation_other(primary)
        shown = other if other in visible_others else None
        shape_ids = []
        for row in group:
            shape_ids = _merge_unique(
                shape_ids, _shapes_for(shapes_by_entity, PpmCanvasEntityType.WORK_ITEM, row.issue_id)
            )
        events.append(
            {
                "id": f"work_item.relation:{primary.id}",
                "kind": "work_item.relation",
                "occurred_at": max(row.created_at for row in group),
                "actor": _user_actor(primary.actor),
                "entity": _work_item_entity(project, issue),
                "shape_ids": shape_ids,
                "detail": {
                    "field": primary.field,
                    "old": shown if primary.verb == "deleted" else None,
                    "new": shown if primary.verb == "updated" else None,
                },
            }
        )
    return events, len(rows) == fetch


def _git_events(*, project, issues, shapes_by_entity, since, until):
    if not issues:
        return [], False
    links = list(
        PpmGitLink.objects.filter(
            workspace_id=project.workspace_id,
            project_id=project.id,
            object_type=PpmGitObjectType.PULL_REQUEST,
            status=PpmGitLinkStatus.ACTIVE,
            repository__status=PpmGitRepositoryStatus.ACTIVE,
            work_item_id__in=list(issues),
        )
        .filter(
            Q(git_object__isnull=True, created_at__gt=since)
            | Q(git_object__first_seen_at__gt=since)
            | Q(git_object__state="merged", git_object__provider_updated_at__gt=since)
            | Q(git_object__state="merged", git_object__provider_merged_at__gt=since)
        )
        .select_related("git_object")
        .order_by("-created_at", "id")[:GIT_LINK_SCAN_LIMIT]
    )
    groups = defaultdict(list)
    for link in links:
        groups[link.git_object_id or link.id].append(link)
    events = []
    for pull_request_id, group in groups.items():
        git_object = group[0].git_object
        work_item_ids = sorted({link.work_item_id for link in group}, key=lambda item_id: issues[item_id].sequence_id)
        shape_ids = []
        for entity_id in (pull_request_id, *(link.id for link in group)):
            shape_ids = _merge_unique(
                shape_ids, _shapes_for(shapes_by_entity, PpmCanvasEntityType.PULL_REQUEST, entity_id)
            )
        for work_item_id in work_item_ids:
            shape_ids = _merge_unique(
                shape_ids, _shapes_for(shapes_by_entity, PpmCanvasEntityType.WORK_ITEM, work_item_id)
            )
        ref = (git_object.ref if git_object else group[0].ref) or ""
        entity = {
            "type": "pull_request",
            "id": str(pull_request_id),
            "title": _clean_text(git_object.title if git_object else group[0].title) or "",
        }
        if ref:
            entity["identifier"] = f"#{ref}"
        detail = {
            "field": "work_items",
            "new": ", ".join(_identifier(project, issues[item_id]) for item_id in work_item_ids),
        }
        # «Влит» — время слияния у провайдера: поздние комментарии и метки сдвигают только `provider_updated_at`, и
        # влитый до отметки PR не возвращается в ленту. PR, ещё не пересинхронизированный после S2a (reconcile раз в
        # 15 минут дописывает `merged_at`), — по последнему обновлению, как раньше.
        merged_at = None
        if git_object is not None and git_object.state == "merged":
            merged_at = git_object.provider_merged_at or git_object.provider_updated_at
        # «Открыт» — момент, когда PPM впервые увидел PR (провайдер не сообщает дату создания); PR, у которого с
        # начала окна не было активности у провайдера или который влит до начала окна, — это старый PR (например,
        # из первой синхронизации), не «открытый сейчас». PR, впервые увиденный уже влитым (слияние — или, без его
        # времени, последнее обновление — не позже первого появления: репозиторий подключили позже, пропущен
        # webhook), тоже не «открыт»: иначе «открыт» оказался бы позже «влит».
        opened_at = git_object.first_seen_at if git_object else min(link.created_at for link in group)
        historical = git_object is not None and any(
            moment is not None and moment <= since
            for moment in (git_object.provider_updated_at, git_object.provider_merged_at)
        )
        seen_merged = merged_at is not None and merged_at <= opened_at
        if since < opened_at <= until and not historical and not seen_merged:
            events.append(
                {
                    "id": f"git.pull_request.opened:{pull_request_id}",
                    "kind": "git.pull_request.opened",
                    "occurred_at": opened_at,
                    "actor": None,
                    "entity": entity,
                    "shape_ids": shape_ids,
                    "detail": detail,
                }
            )
        if merged_at and since < merged_at <= until:
            events.append(
                {
                    "id": f"git.pull_request.merged:{pull_request_id}",
                    "kind": "git.pull_request.merged",
                    "occurred_at": merged_at,
                    "actor": None,
                    "entity": entity,
                    "shape_ids": shape_ids,
                    "detail": detail,
                }
            )
    return events, len(links) == GIT_LINK_SCAN_LIMIT


def _vault_events(*, project, shapes_by_entity, since, until, fetch):
    entry_ids = [
        entity_id for entity_type, entity_id in shapes_by_entity if entity_type == PpmCanvasEntityType.VAULT_FILE.value
    ]
    if not entry_ids:
        return [], False
    versions = list(
        PpmVaultVersion.objects.filter(
            workspace_id=project.workspace_id,
            project_id=project.id,
            entry_id__in=entry_ids,
            entry__status=PpmVaultEntryStatus.ACTIVE,
            status=PpmVaultVersionStatus.VERIFIED,
            created_at__gt=since,
            created_at__lte=until,
        )
        .select_related("entry")
        .defer("content_text")
        .order_by("-created_at", "-id")[:fetch]
    )
    events = [
        {
            "id": f"vault.version:{version.id}",
            "kind": "vault.version",
            "occurred_at": version.created_at,
            "actor": None,
            "author_id": version.created_by,
            "entity": {
                "type": "vault_file",
                "id": str(version.entry_id),
                "title": _clean_text(version.entry.name) or "",
            },
            "shape_ids": _shapes_for(shapes_by_entity, PpmCanvasEntityType.VAULT_FILE, version.entry_id),
            "detail": {
                "field": "version",
                "old": str(version.version - 1) if version.version > 1 else None,
                "new": str(version.version),
            },
        }
        for version in versions
    ]
    return events, len(versions) == fetch


def _node_time(value):
    if not isinstance(value, str) or len(value) > 64:
        return None
    try:
        parsed = parse_datetime(value)
    except ValueError:
        return None
    if parsed is None:
        return None
    return timezone.make_aware(parsed, dt_timezone.utc) if timezone.is_naive(parsed) else parsed


def _version_shape_ids(*, board_id, version):
    with connection.cursor() as cursor:
        cursor.execute(VERSION_SHAPE_IDS_SQL, [board_id, version])
        return {row[0] for row in cursor.fetchall()}


def _version_marks(sql, *, board_id, low, high, shape_ids):
    """Версия из (low, high], отметившая каждую фигуру (см. FIRST_ADDED_SQL / LAST_CHANGED_SQL): фигура → (время
    версии, её автор).

    Без GIN-индекса на `added_shape_ids`/`changed_shape_ids` (финальная волна, final-pass S2a): запрос ограничен доской
    и диапазоном версий (индексы `(board, version)`), окно ленты — не больше 30 дней, а массивы отметок у версии
    короткие (обычно 0–1 id) и лежат в строке версии, без распаковки снимка. Замер на длинной истории — 3000 версий
    доски за 30 дней, 300 фигур, сохранены настоящим `save_canvas_snapshot` (тестовый стенд, docker на macOS): вся лента
    — медиана 25 мс при `since` до первой версии (отметки по всем 3000 версиям), 21 мс за 15 дней, 20 мс за сутки;
    самые широкие запросы отметок (300 id, версии (1, 3000]) — 4,8 и 6,0 мс, рост линейный по числу версий в окне.
    Порог для индекса — 500 мс; GIN добавил бы запись двух индексов к каждому автосохранению ради чтения, которое
    идёт не чаще раза в минуту на открытую панель."""
    ids = list(shape_ids)
    with connection.cursor() as cursor:
        cursor.execute(sql, [board_id, low, high, ids, ids])
        return {shape_id: (created_at, created_by) for shape_id, created_at, created_by in cursor.fetchall()}


def _grid_middle(lower, upper):
    """Точка деления диапазона (lower, upper) на фиксированной сетке: число с наибольшей степенью двойки внутри. Точки
    сетки зависят только от границ диапазона, а не от текущей версии доски."""
    step = 1 << ((upper - 1).bit_length() - 1)
    while step > 1 and (upper - 1) // step * step <= lower:
        step >>= 1
    return (upper - 1) // step * step


def _first_versions(*, board_id, low, high, shape_ids):
    """Для фигур, которых нет в версии `low` (0 — пустая доска) и которые есть в `high`, находит версию из (low, high],
    где фигура появилась: деление по фиксированной сетке (`_grid_middle`), одна короткая выборка ключей на шаг, не
    больше SHAPE_TIME_PROBE_BUDGET шагов на весь запрос. Фигуре, для которой бюджет кончился, достаётся нижняя граница
    её диапазона + 1 версия — самое раннее возможное время, а не «сейчас». История версий неизменяема, а сетка не
    зависит от текущей версии, поэтому ответ устойчив между опросами."""
    found = {}
    probes = 0
    stack = [(low, high, set(shape_ids))]
    while stack:
        lower, upper, pending = stack.pop()
        if not pending:
            continue
        if upper - lower <= 1 or probes >= SHAPE_TIME_PROBE_BUDGET:
            found.update(dict.fromkeys(pending, lower + 1))
            continue
        middle = _grid_middle(lower, upper)
        present = pending & _version_shape_ids(board_id=board_id, version=middle)
        probes += 1
        stack.append((middle, upper, pending - present))
        stack.append((lower, middle, present))
    return found


def _board_events(*, board, current, shapes, nodes, since, until):
    """События самой доски: текущая сохранённая версия против версии на момент `since` («база» — последняя версия,
    сохранённая не позже `since`; 0 — доски тогда ещё не было).

    - **Исходное содержимое (M-1).** Фигуры первой сохранённой версии доски (наименьший номер: первое сохранение новой
      доски — например, собранная карта; у копии — версия 1 с содержимым копии) — не новость: `board.node.added` они
      не дают никогда, при любом `since` (правило по id фигуры, поэтому и удалённая, а потом возвращённая фигура
      исходного содержимого не «добавлена»). Иначе каждый, кто впервые открыл свежую карту, видел бы «добавленными» все
      её карточки.
    - **Добавлено** — фигура, которой нет ни в базе, ни в исходном содержимом: карточка PPM со своим `created_at` после
      `since` — с этим временем и автором из узла; остальные (нативные фигуры; карточки, вставленные или скопированные
      со старым `created_at`) — со временем и автором версии, где фигура появилась (отметки S2a; для истории до S2a —
      поиск).
    - **Изменено** — карточка PPM, чей `updated_at` позже `since`: если она есть в базе и создана не позже `since`
      (карточка, созданная позже, — «добавлена», а не «изменена»); если она из исходного содержимого, а база раньше его
      (`since` до первой версии), — только когда её правку сохранила версия после исходного содержимого (отметка S2a
      `changed_shape_ids`): `created_at`/`updated_at` исходных карточек собранной карты лежат в окне, но это не правка.
      Автор — автор версии, сохранившей текущий `updated_at`.

    Все отметки ищутся в версиях после `max(база, первая версия)`: раньше исходного содержимого новостей нет."""
    if current is None:
        return []
    bounds = PpmCanvasVersion.objects.filter(board=board, version__lte=current.version).aggregate(
        first=Min("version"),
        base=Max("version", filter=Q(created_at__lte=since)),
    )
    first_version = bounds["first"] or current.version
    base_version = bounds["base"] or 0
    initial_ids = _version_shape_ids(board_id=board.id, version=first_version)
    if base_version == first_version:
        base_ids = initial_ids
    else:
        base_ids = _version_shape_ids(board_id=board.id, version=base_version) if base_version else set()
    events = []
    untimed = []
    changed = {}
    # Карточки исходного содержимого, которых нет в базе: «изменены», только если есть отметка правки после него.
    edited_only_by_mark = set()
    for shape_id, record in shapes.items():
        shape_type = record.get("type")
        if shape_type == PPM_NODE_SHAPE_TYPE:
            node = nodes.get(shape_id)
            if node is None:
                continue
            created_at = _node_time(node.get("created_at"))
            updated_at = _node_time(node.get("updated_at"))
            entity = {"type": "node", "id": shape_id}
            title = _clean_text(node.get("title"), MAX_TITLE_CHARS) if isinstance(node.get("title"), str) else None
            if title:
                entity["title"] = title
            detail = {"field": "kind", "new": _clean_text(node.get("kind"), 40)}
            if shape_id in base_ids or shape_id in initial_ids:
                in_base = shape_id in base_ids
                if updated_at and since < updated_at and (not in_base or created_at is None or created_at <= since):
                    event = _board_event("board.node.changed", shape_id, min(updated_at, until), entity, detail)
                    event["id"] = f"board.node.changed:{shape_id}:{updated_at.isoformat()}"
                    changed[shape_id] = event
                    if not in_base:
                        edited_only_by_mark.add(shape_id)
            elif created_at and since < created_at:
                events.append(
                    _board_event(
                        "board.node.added",
                        shape_id,
                        min(created_at, until),
                        entity,
                        detail,
                        author_id=node.get("author_id"),
                    )
                )
            else:
                untimed.append((shape_id, entity, detail))
        elif (
            isinstance(shape_type, str)
            and shape_type not in UNTRACKED_NATIVE_SHAPE_TYPES
            and shape_id not in base_ids
            and shape_id not in initial_ids
        ):
            untimed.append(
                (
                    shape_id,
                    {"type": "node", "id": shape_id},
                    {"field": "shape_type", "new": _clean_text(shape_type, 40)},
                )
            )
    span = {"board_id": board.id, "low": max(base_version, first_version), "high": current.version}
    if changed:
        # Узел хранит создателя, а не редактора: автор правки — автор версии, сохранившей текущий `updated_at`.
        marks = _version_marks(LAST_CHANGED_SQL, shape_ids=changed, **span)
        for shape_id in edited_only_by_mark - marks.keys():
            del changed[shape_id]
        for shape_id, (_, author_id) in marks.items():
            changed[shape_id]["author_id"] = author_id
        events.extend(changed.values())
    if untimed:
        # Фигура без своей метки времени (нативная; карточка PPM, вставленная или скопированная со старым
        # `created_at`) — время и автор версии, где она появилась.
        appeared = _version_marks(FIRST_ADDED_SQL, shape_ids=[shape_id for shape_id, _, _ in untimed], **span)
        legacy = []
        for shape_id, entity, detail in untimed:
            if shape_id in appeared:
                occurred_at, author_id = appeared[shape_id]
                events.append(
                    _board_event("board.node.added", shape_id, occurred_at, entity, detail, author_id=author_id)
                )
            else:
                legacy.append((shape_id, entity, detail))
        if legacy:
            events.extend(_legacy_added_events(board=board, current=current, low=span["low"], legacy=legacy))
    return events


def _legacy_added_events(*, board, current, low, legacy):
    """Фигуры, появившиеся в версиях, сохранённых до S2a (без отметок), — поиск по истории без автора. Диапазон — от
    `low` (база или исходное содержимое, если оно позже; в `low` этих фигур нет) до последней версии без отметок: все
    версии после неё отмечены, и фигура, которой нет в их отметках, в ней уже была. Эта граница не сдвигается с новыми
    сохранениями, поэтому время устойчиво между опросами."""
    shape_ids = [shape_id for shape_id, _, _ in legacy]
    legacy_high = (
        PpmCanvasVersion.objects.filter(
            board=board,
            version__gt=low,
            version__lte=current.version,
            added_shape_ids__isnull=True,
        )
        .order_by("-version")
        .values_list("version", flat=True)
        .first()
    )
    appeared = (
        _first_versions(board_id=board.id, low=low, high=legacy_high, shape_ids=shape_ids)
        if legacy_high
        # Все версии окна отмечены, а фигура не отмечена (запись с нестроковым id): первая версия после `low`.
        else dict.fromkeys(shape_ids, low + 1)
    )
    saved_at = dict(
        PpmCanvasVersion.objects.filter(board=board, version__in=set(appeared.values())).values_list(
            "version", "created_at"
        )
    )
    return [
        _board_event("board.node.added", shape_id, saved_at.get(appeared[shape_id], current.created_at), entity, detail)
        for shape_id, entity, detail in legacy
    ]


def _board_event(kind, shape_id, occurred_at, entity, detail, *, author_id=None):
    return {
        "id": f"{kind}:{shape_id}",
        "kind": kind,
        "occurred_at": occurred_at,
        "actor": None,
        "author_id": author_id,
        "entity": entity,
        "shape_ids": [shape_id],
        "detail": detail,
    }


def _resolve_authors(events, *, workspace_id):
    """Превращает `author_id` событий в `actor` — одним запросом на все события; `author_id` из события убирается (в
    ответ он не идёт). Откуда `author_id`:

    - `board.node.added` карточки PPM со своим `created_at` в окне — `author_id` узла из снимка (его пишет клиент, он
      может быть любым UUID или не-UUID вроде `"local-user"`);
    - `board.node.added` фигуры без своей метки времени (нативная фигура; карточка, вставленная или скопированная со
      старым `created_at`) и `board.node.changed` — автор версии доски (`created_by`), которая фигуру добавила или
      сохранила текущую правку карточки (отметки S2a); у истории до S2a автора нет;
    - `vault.version` — автор версии файла Хранилища.

    Имя показывается, только если это активный участник рабочего пространства доски (не удалён и не отключён); иначе
    `actor` остаётся `null`: чужой UUID в снимке не раскрывает имя постороннего пользователя. Не-UUID пропускается.
    События с автором из Plane (`IssueActivity.actor` задач) сюда приходят уже с `actor` и без `author_id`."""
    pending = defaultdict(list)
    for event in events:
        raw = event.pop("author_id", None)
        if not raw:
            continue
        try:
            pending[uuid.UUID(str(raw))].append(event)
        except ValueError:
            continue
    if not pending:
        return
    users = User.objects.filter(
        id__in=list(pending),
        member_workspace__workspace_id=workspace_id,
        member_workspace__is_active=True,
        member_workspace__deleted_at__isnull=True,
    ).only("id", "display_name", "first_name", "last_name")
    for user in users:
        for event in pending[user.id]:
            event["actor"] = _user_actor(user)


def _serialize_event(event):
    return {
        "id": event["id"],
        "kind": event["kind"],
        "occurred_at": event["occurred_at"].isoformat(),
        "actor": event["actor"],
        "entity": event["entity"],
        "shape_ids": event["shape_ids"],
        "detail": event["detail"],
    }
