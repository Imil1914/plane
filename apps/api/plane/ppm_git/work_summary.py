"""G2.3 — Git-объекты в отчётах о работе: подписи для вставки (G1) и сводка «Что сделано за период» (G2).

Подпись (формат зафиксирован планом ``docs/superpowers/plans/2026-09-29-g23-reports/plan.md``): коммит — «коммит a1b2c3d
«Сообщение…»», PR — «PR #12 «Название» · Слит 28 сент.» / «· Открыт» / «· Черновик» / «· Закрыт». Текст в кавычках —
не длиннее 72 символов (длиннее — обрезается с «…»); дата слияния — в часовом поясе проекта, месяцы — как в интерфейсе
(date-fns ``ru``), год — только если он не тот, о котором речь (текущий для поиска, год конца периода для сводки).
В поиске статус PR — текущий, в сводке — на конец периода (сводка задним числом не меняется).

Сводка — по образцу ленты доски (``plane.ppm_canvas.changes``), но на уровне всего проекта:

- задачи — видимые пользователю задачи проекта (``get_visible_work_items``: ограниченный гость видит только свои;
  архивные остаются, удалённые и черновики — нет), у которых за период была смена статуса (``IssueActivity``,
  ``field="state"``); период — сутки ``from`` … ``to`` включительно в часовом поясе проекта (``Project.timezone``,
  ``ZoneInfo``: дни перехода на летнее/зимнее время длятся 23 и 25 часов);
- статус и группа задачи — на конец периода: статус последней смены внутри периода (задачу закрыли в периоде и вернули
  в работу после — в сводке она «Сделано»); группы: «Сделано» (completed), «В работе» (started), «Прочее» (остальное);
  состояния Plane по умолчанию (точное английское имя своей группы) называются по-русски, как в интерфейсе PPM;
- Git — только через активные связи этих задач (``PpmGitLink``) с активными коммитами и PR активных репозиториев
  этого же проекта; связь без Git-объекта (ручная ссылка) даты не имеет и в сводку не входит. Коммит — если его время
  (у провайдера — время автора, иначе первое появление в PPM) в периоде. PR — по состоянию на конец периода: слит в
  периоде (время слияния, без него — последнее обновление) — «Слит 28 сент.»; иначе — если PPM увидел его до конца
  периода, последняя активность не раньше начала периода и слит он (если слит) после конца: «Открыт»/«Черновик», а
  закрытый без слияния — «Закрыт», только если его последняя активность раньше конца периода (время закрытия PPM не
  хранит; позже — считается открытым на конец периода). Слитый до начала периода — не входит. Коммит без задачи, как и
  Git задачи без смены статуса, в сводку не попадает;
- итоги: число задач по группам и число разных коммитов и PR (объект, связанный с двумя задачами, считается один раз);
- готовый текст: markdown (заметки Хранилища) и HTML (страницы, описания; только ``h3``, ``p``, ``ul``, ``li``, ``a``,
  ``strong``, всё экранировано) — ссылки только на задачи и Git-объекты этого проекта; ссылкой становится только адрес
  http(s) с хостом (у задачи — ещё путь этого же приложения) без пробелов, управляющих символов и ``\\``, иначе — текст.

Число запросов не зависит от числа задач и объектов: смены статуса, задачи, статусы, связи — по одному; при усечении
(``WORK_SUMMARY_MAX_ITEMS`` задач, ``WORK_SUMMARY_MAX_GIT_OBJECTS`` строк Git) — ещё один на точные итоги.
"""

import re
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from datetime import timezone as dt_timezone
from html import escape
from typing import NamedTuple
from urllib.parse import quote, urlsplit, urlunsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.conf import settings
from django.db.models import Case, Count, F, Q, When
from django.db.models.functions import Coalesce
from django.utils import timezone

from plane.db.models import IssueActivity, State
from plane.ppm_canvas.services import get_visible_work_items

from .models import PpmGitLink, PpmGitLinkStatus, PpmGitObjectType, PpmGitRepositoryStatus
from .services import PpmGitError


WORK_SUMMARY_MAX_DAYS = 92
WORK_SUMMARY_MAX_ITEMS = 500
WORK_SUMMARY_MAX_GIT_OBJECTS = 2000
LABEL_TEXT_LIMIT = 72
# Короткие месяцы в родительном падеже — те же, что у дат интерфейса (date-fns `ru`, formattingMonthValues.abbreviated).
RU_MONTHS = ("янв.", "фев.", "мар.", "апр.", "мая", "июн.", "июл.", "авг.", "сент.", "окт.", "нояб.", "дек.")
STATE_GROUPS = {"completed": "done", "started": "in_progress"}  # всё остальное — «other»
# Состояния Plane по умолчанию (``plane/db/models/state.py``, DEFAULT_STATES): группа → (имя в БД, имя в интерфейсе
# PPM — ``ux.state.*`` ru из ``packages/ppm-brand``; правило — ``getPpmStateDisplayName`` в web ``lib/ppm-design.ts``).
DEFAULT_STATE_NAMES = {
    "backlog": ("Backlog", "Бэклог"),
    "unstarted": ("Todo", "К работе"),
    "started": ("In Progress", "В работе"),
    "completed": ("Done", "Готово"),
    "cancelled": ("Cancelled", "Отменена"),
    "triage": ("Triage", "На разборе"),
}
NO_STATE_NAME = "Без статуса"
GROUPS = (("done", "Сделано"), ("in_progress", "В работе"), ("other", "Прочее"))
GROUP_ORDER = {key: index for index, (key, _) in enumerate(GROUPS)}
# Ключи словарей — простые строки (значения из БД приходят строками).
COMMIT = PpmGitObjectType.COMMIT.value
PULL_REQUEST = PpmGitObjectType.PULL_REQUEST.value
ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
EMPTY_TEXT = "За этот период ни одна задача не сменила статус."
SHORTEN_TEXT = "Сократите период, чтобы увидеть все."
TASKS_CUT_TEXT = "Задач больше, чем помещается в сводку: показаны {shown} из {total}. " + SHORTEN_TEXT
OBJECTS_CUT_TEXT = "Коммитов и PR больше, чем помещается в сводку: показаны не все. " + SHORTEN_TEXT


# --- подписи Git-объектов (поиск и сводка) ----------------------------------------------------------------------------


def project_timezone(name):
    """Часовой пояс проекта (``Project.timezone``, имена IANA) как ``ZoneInfo``; неизвестный — UTC."""
    try:
        return ZoneInfo(name or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return dt_timezone.utc


def current_year(tz):
    return timezone.now().astimezone(tz).year


def ru_day_month(value):
    return f"{value.day} {RU_MONTHS[value.month - 1]}"


def _clip(text, limit=LABEL_TEXT_LIMIT):
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else f"{text[: limit - 1].rstrip()}…"


def _before(moment, as_of):
    return moment is not None and moment < as_of


def _pull_request_state(git_object, as_of):
    """Состояние PR сейчас, а с ``as_of`` (конец периода сводки) — на тот момент: слит позже — был открыт; закрыт без
    слияния, но последняя активность позже (время закрытия PPM не хранит) — считается открытым."""
    state = git_object.state
    if as_of is None:
        return state
    if state == "merged" and not _before(git_object.provider_merged_at or git_object.provider_updated_at, as_of):
        return "open"
    if state == "closed" and not _before(git_object.provider_updated_at or git_object.first_seen_at, as_of):
        return "open"
    return state


def _pull_request_status(git_object, *, tz, reference_year, as_of=None):
    state = _pull_request_state(git_object, as_of)
    if state == "merged":
        if git_object.provider_merged_at is None:  # слит до того, как PPM начал хранить время слияния
            return "Слит"
        merged_on = git_object.provider_merged_at.astimezone(tz).date()
        year = "" if merged_on.year == reference_year else f" {merged_on.year}"
        return f"Слит {ru_day_month(merged_on)}{year}"
    if state == "closed":
        return "Закрыт"
    if state == "open":
        return "Черновик" if git_object.is_draft else "Открыт"
    return ""


def git_object_label(git_object, *, tz, reference_year, as_of=None):
    """Готовая подпись для вставки: «коммит a1b2c3d «Сообщение…»» или «PR #12 «Название» · Слит 28 сент.»; статус PR —
    текущий, а с ``as_of`` — на этот момент (конец периода сводки)."""
    title = _clip(git_object.title)
    if git_object.object_type == PpmGitObjectType.COMMIT:
        return f"коммит {(git_object.commit_sha or git_object.ref)[:7]} «{title}»"
    if git_object.object_type == PpmGitObjectType.PULL_REQUEST:
        label = f"PR #{git_object.ref} «{title}»"
        status = _pull_request_status(git_object, tz=tz, reference_year=reference_year, as_of=as_of)
        return f"{label} · {status}" if status else label
    return title


def labeled_git_object(git_object, *, serialize, tz, reference_year, as_of=None):
    """Поля ``serialize_git_object`` (передаётся из ``views``) и ``label``."""
    label = git_object_label(git_object, tz=tz, reference_year=reference_year, as_of=as_of)
    return {**serialize(git_object), "label": label}


# --- период -----------------------------------------------------------------------------------------------------------


def _range_error(message):
    return PpmGitError("WORK_SUMMARY_RANGE_INVALID", message, {"max_days": WORK_SUMMARY_MAX_DAYS})


def _parse_date(value):
    if not isinstance(value, str) or not ISO_DATE.fullmatch(value):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def parse_period(raw_from, raw_to):
    """``from``/``to`` (``YYYY-MM-DD``, оба конца включительно, не длиннее 92 дней) → две даты; иначе 400
    ``WORK_SUMMARY_RANGE_INVALID``."""
    start, end = _parse_date(raw_from), _parse_date(raw_to)
    if start is None or end is None:
        raise _range_error("Укажите период: даты «с» и «по» в формате ГГГГ-ММ-ДД.")
    if start > end:
        raise _range_error("Дата начала периода позже даты окончания.")
    if (end - start).days + 1 > WORK_SUMMARY_MAX_DAYS:
        raise _range_error(f"Период сводки — не больше {WORK_SUMMARY_MAX_DAYS} дней.")
    return start, end


def period_bounds(start, end, tz):
    """Полночь ``start`` … полночь после ``end`` в часовом поясе проекта (правая граница не входит), в UTC. ``ZoneInfo``
    с fold=0: день перехода на зимнее время длится 25 часов, на летнее — 23."""
    try:
        return (
            datetime.combine(start, time.min, tzinfo=tz).astimezone(dt_timezone.utc),
            datetime.combine(end + timedelta(days=1), time.min, tzinfo=tz).astimezone(dt_timezone.utc),
        )
    except OverflowError as error:
        raise _range_error("Период выходит за пределы календаря.") from error


# --- сводка -----------------------------------------------------------------------------------------------------------


def app_origin():
    """Публичный адрес PPM для ссылок на задачи (отчёт уходит и за пределы приложения: экспорт, копия заметки) — та же
    настройка, что у ``plane.utils.host.base_host(is_app=True)``: ``APP_BASE_URL``, иначе ``WEB_URL``; нет — ссылки
    относительные."""
    for candidate in (getattr(settings, "APP_BASE_URL", None), getattr(settings, "WEB_URL", None)):
        if isinstance(candidate, str) and candidate.strip():
            parsed = urlsplit(candidate.strip())
            if parsed.scheme in ("http", "https") and parsed.netloc:
                return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))
    return ""


def _period_links(project, *, work_item_ids, start_at, end_at):
    """Активные связи задач с коммитами и PR этого проекта, которые относятся к периоду (правила — в докстринге модуля):
    коммит написан в периоде; PR слит в периоде или открыт на его конец."""
    pull_request = Q(git_object__object_type=PpmGitObjectType.PULL_REQUEST)
    merged_in_period = Q(git_object__state="merged", g23_merged_at__gte=start_at, g23_merged_at__lt=end_at)
    open_at_end = Q(git_object__first_seen_at__lt=end_at, g23_activity__gte=start_at) & (
        ~Q(git_object__state="merged") | Q(g23_merged_at__gte=end_at)
    )
    return (
        PpmGitLink.objects.filter(
            workspace_id=project.workspace_id,
            project_id=project.id,
            status=PpmGitLinkStatus.ACTIVE,
            repository__status=PpmGitRepositoryStatus.ACTIVE,
            work_item_id__in=work_item_ids,
            git_object__workspace_id=project.workspace_id,
            git_object__project_id=project.id,
            git_object__is_active=True,
            git_object__object_type__in=(PpmGitObjectType.COMMIT, PpmGitObjectType.PULL_REQUEST),
        )
        .alias(
            # Коммит — время автора; PR — последняя активность у провайдера; без них — первое появление в PPM.
            g23_activity=Coalesce("git_object__provider_updated_at", "git_object__first_seen_at"),
            g23_merged_at=Coalesce("git_object__provider_merged_at", "git_object__provider_updated_at"),
        )
        .filter(
            Q(git_object__object_type=PpmGitObjectType.COMMIT, g23_activity__gte=start_at, g23_activity__lt=end_at)
            | (pull_request & (merged_in_period | open_at_end))
        )
        .alias(
            g23_moment=Case(
                When(pull_request & merged_in_period, then=F("g23_merged_at")),
                default=F("g23_activity"),
            )
        )
    )


def state_display_name(state):
    """Имя статуса в сводке — как в интерфейсе PPM: точное имя состояния Plane по умолчанию в своей группе — по-русски,
    своё или переименованное — как есть."""
    if state is None:
        return NO_STATE_NAME
    default = DEFAULT_STATE_NAMES.get(state.group)
    return default[1] if default is not None and default[0] == state.name else state.name


def _work_item_url(project, issue, key, origin):
    slug = quote(project.workspace.slug, safe="")
    if issue.archived_at:
        return f"{origin}/{slug}/projects/{project.id}/archives/issues/{issue.id}"
    return f"{origin}/{slug}/browse/{quote(key, safe='-')}/"


class _Row(NamedTuple):
    """Задача сводки: сама задача, её статус на конец периода и группа («done» / «in_progress» / «other»)."""

    issue: object
    state: object
    group: str


def _changed_work_items(*, project, user, start_at, end_at):
    """Видимые задачи проекта со сменой статуса в периоде — по группам, внутри группы по номеру задачи."""
    visible = get_visible_work_items(project=project, user=user, include_inactive=True).filter(
        deleted_at__isnull=True,
        is_draft=False,
    )
    changes = (
        IssueActivity.objects.filter(
            workspace_id=project.workspace_id,
            project_id=project.id,
            field="state",
            verb="updated",
            created_at__gte=start_at,
            created_at__lt=end_at,
            issue_id__in=visible.values("id"),
        )
        .order_by("created_at", "id")
        .values_list("issue_id", "new_identifier")
    )
    final_state_ids = {}
    for issue_id, state_id in changes:
        final_state_ids[issue_id] = state_id  # последняя смена внутри периода — статус на его конец
    if not final_state_ids:
        return []
    issues = visible.filter(id__in=list(final_state_ids)).select_related("state")
    issues = issues.only("id", "name", "sequence_id", "archived_at", "state", "state__name", "state__group")
    state_ids = {state_id for state_id in final_state_ids.values() if state_id}
    states = (
        {state.id: state for state in State.all_state_objects.filter(id__in=state_ids, project_id=project.id)}
        if state_ids
        else {}
    )
    rows = []
    for issue in issues:
        # Статус удалён насовсем — текущий статус задачи.
        state = states.get(final_state_ids[issue.id]) or issue.state
        rows.append(_Row(issue, state, STATE_GROUPS.get(state.group, "other") if state else "other"))
    rows.sort(key=lambda row: (GROUP_ORDER[row.group], row.issue.sequence_id))
    return rows


def _git_of_work_items(*, project, rows, start_at, end_at):
    """Коммиты и PR периода по задачам (без повторов), не больше ``WORK_SUMMARY_MAX_GIT_OBJECTS`` строк; второе
    значение — было ли усечение."""
    if not rows:
        return {}, False
    links = list(
        _period_links(project, work_item_ids=[row.issue.id for row in rows], start_at=start_at, end_at=end_at)
        .select_related("git_object")
        .order_by("-g23_moment", "git_object_id", "id")[: WORK_SUMMARY_MAX_GIT_OBJECTS + 1]
    )
    truncated = len(links) > WORK_SUMMARY_MAX_GIT_OBJECTS
    by_work_item = defaultdict(lambda: {COMMIT: {}, PULL_REQUEST: {}})
    for link in links[:WORK_SUMMARY_MAX_GIT_OBJECTS]:
        by_work_item[link.work_item_id][link.git_object.object_type].setdefault(link.git_object_id, link.git_object)
    return by_work_item, truncated


def _git_totals(*, project, rows, by_work_item, truncated, start_at, end_at):
    """Число разных коммитов и PR: из выбранного, а при усечении — одним запросом по всем задачам периода."""
    if truncated:
        return dict(
            _period_links(project, work_item_ids=[row.issue.id for row in rows], start_at=start_at, end_at=end_at)
            .order_by()
            .values_list("git_object__object_type")
            .annotate(total=Count("git_object_id", distinct=True))
        )
    seen = {COMMIT: set(), PULL_REQUEST: set()}
    for objects in by_work_item.values():
        for object_type, by_id in objects.items():
            seen[object_type].update(by_id)
    return {object_type: len(ids) for object_type, ids in seen.items()}


def build_work_summary(*, project, user, start, end, serialize):
    """Ответ ``GET …/git/work-summary/``: ``from``, ``to``, ``totals``, ``items``, ``truncated``, ``markdown``,
    ``html``.

    ``project`` — с ``workspace`` (адреса задач), ``serialize`` — ``views.serialize_git_object``."""
    tz = project_timezone(project.timezone)
    start_at, end_at = period_bounds(start, end, tz)
    rows = _changed_work_items(project=project, user=user, start_at=start_at, end_at=end_at)
    listed = rows[:WORK_SUMMARY_MAX_ITEMS]
    tasks_truncated = len(rows) > len(listed)
    by_work_item, objects_truncated = _git_of_work_items(project=project, rows=listed, start_at=start_at, end_at=end_at)
    truncated = tasks_truncated or objects_truncated
    git_totals = _git_totals(
        project=project,
        rows=rows,
        by_work_item=by_work_item,
        truncated=truncated,
        start_at=start_at,
        end_at=end_at,
    )
    totals = {group: 0 for group, _ in GROUPS}
    for row in rows:
        totals[row.group] += 1
    totals["commits"] = git_totals.get(COMMIT, 0)
    totals["pull_requests"] = git_totals.get(PULL_REQUEST, 0)

    origin = app_origin()

    def labeled(objects):
        return [
            labeled_git_object(git_object, serialize=serialize, tz=tz, reference_year=end.year, as_of=end_at)
            for git_object in objects.values()
        ]

    items = []
    for row in listed:
        key = f"{project.identifier}-{row.issue.sequence_id}"
        objects = by_work_item.get(row.issue.id, {COMMIT: {}, PULL_REQUEST: {}})
        items.append(
            {
                "work_item": {
                    "id": str(row.issue.id),
                    "key": key,
                    "name": row.issue.name,
                    "url": _work_item_url(project, row.issue, key, origin),
                    "state_name": state_display_name(row.state),
                    "state_group": row.group,
                },
                "commits": labeled(objects[COMMIT]),
                "pull_requests": labeled(objects[PULL_REQUEST]),
            }
        )

    notes = []
    if tasks_truncated:
        notes.append(TASKS_CUT_TEXT.format(shown=len(listed), total=len(rows)))
    if objects_truncated:
        notes.append(OBJECTS_CUT_TEXT)
    title = period_title(start, end)
    return {
        "from": start.isoformat(),
        "to": end.isoformat(),
        "totals": totals,
        "items": items,
        "truncated": truncated,
        "markdown": render_markdown(title=title, totals=totals, notes=notes, items=items),
        "html": render_html(title=title, totals=totals, notes=notes, items=items),
    }


# --- готовый текст ----------------------------------------------------------------------------------------------------


def period_title(start, end):
    """«Что сделано с 22 по 28 сент. 2026» (месяц и год не повторяются, если совпадают)."""
    if start == end:
        return f"Что сделано за {ru_day_month(start)} {start.year}"
    if start.year != end.year:
        return f"Что сделано с {ru_day_month(start)} {start.year} по {ru_day_month(end)} {end.year}"
    if start.month != end.month:
        return f"Что сделано с {ru_day_month(start)} по {ru_day_month(end)} {end.year}"
    return f"Что сделано с {start.day} по {ru_day_month(end)} {end.year}"


def totals_line(totals):
    return (
        f"Сделано: {totals['done']} · В работе: {totals['in_progress']} · Прочее: {totals['other']} · "
        f"Коммитов: {totals['commits']} · PR: {totals['pull_requests']}"
    )


def _clean_url(url):
    """Без пробелов (в т. ч. переводов строк), управляющих символов и ``\\`` — браузер читает ``\\`` как ``/``, и
    ``/\\evil`` стал бы чужим хостом."""
    return (
        isinstance(url, str)
        and url != ""
        and not any(character.isspace() or character == "\\" or not character.isprintable() for character in url)
    )


def _absolute_href(url):
    """Адрес http(s) с хостом — иначе ``""`` (текст без ссылки)."""
    if not _clean_url(url):
        return ""
    try:
        parsed = urlsplit(url)
        return url if parsed.scheme.lower() in ("http", "https") and parsed.hostname else ""
    except ValueError:
        return ""


def _git_href(url):
    """Ссылка на Git-объект (``canonical_url`` от провайдера): только http(s) с хостом."""
    return _absolute_href(url)


def _work_item_href(url):
    """Ссылка на задачу: публичный адрес PPM (http(s) с хостом) или путь этого же приложения (``/…``, не ``//``)."""
    if isinstance(url, str) and url.startswith("/") and not url.startswith("//"):
        return url if _clean_url(url) else ""
    return _absolute_href(url)


def _one_line(text):
    return " ".join(str(text or "").split())


def _task_text(work_item):
    return f"{work_item['key']} «{_one_line(work_item['name'])}»"


def _grouped(items):
    for key, heading in GROUPS:
        group_items = [item for item in items if item["work_item"]["state_group"] == key]
        if group_items:
            yield heading, group_items


def _md_text(text):
    """Как ``escapeMarkdownLabel`` на web (``ppm-git/insert/format.ts``): ``\\``, ``[``, ``]`` — с обратной чертой,
    ``<`` — сущностью."""
    return _one_line(text).replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]").replace("<", "&lt;")


def _md_link(text, href):
    if not href:
        return _md_text(text)
    # Адрес — в угловых скобках (CommonMark): «)» и пробелы не закрывают ссылку; «<» и «>» внутри — кодируются.
    return f"[{_md_text(text)}](<{href.replace('<', '%3C').replace('>', '%3E')}>)"


def render_markdown(*, title, totals, notes, items):
    blocks = [f"### {title}", totals_line(totals), *notes]
    if not items:
        blocks.append(EMPTY_TEXT)
    for heading, group_items in _grouped(items):
        blocks.append(f"**{heading}**")
        lines = []
        for item in group_items:
            work_item = item["work_item"]
            task_link = _md_link(_task_text(work_item), _work_item_href(work_item["url"]))
            lines.append(f"- {task_link} · {_md_text(work_item['state_name'])}")
            for git_object in (*item["commits"], *item["pull_requests"]):
                lines.append(f"  - {_md_link(git_object['label'], _git_href(git_object['canonical_url']))}")
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks) + "\n"


def _html_link(text, href):
    if not href:
        return escape(_one_line(text))
    return f'<a href="{escape(href)}" target="_blank" rel="noopener noreferrer">{escape(_one_line(text))}</a>'


def render_html(*, title, totals, notes, items):
    parts = [f"<h3>{escape(title)}</h3>", f"<p>{escape(totals_line(totals))}</p>"]
    parts.extend(f"<p>{escape(note)}</p>" for note in notes)
    if not items:
        parts.append(f"<p>{escape(EMPTY_TEXT)}</p>")
    for heading, group_items in _grouped(items):
        parts.append(f"<p><strong>{escape(heading)}</strong></p><ul>")
        for item in group_items:
            work_item = item["work_item"]
            parts.append(
                f"<li><p>{_html_link(_task_text(work_item), _work_item_href(work_item['url']))} · "
                f"{escape(_one_line(work_item['state_name']))}</p>"
            )
            git_objects = (*item["commits"], *item["pull_requests"])
            if git_objects:
                parts.append("<ul>")
                parts.extend(
                    f"<li><p>{_html_link(git_object['label'], _git_href(git_object['canonical_url']))}</p></li>"
                    for git_object in git_objects
                )
                parts.append("</ul>")
            parts.append("</li>")
        parts.append("</ul>")
    return "".join(parts)
