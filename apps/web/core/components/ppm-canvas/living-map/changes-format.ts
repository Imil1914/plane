/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// AF2.2 C1 · тексты ленты «Что изменилось» как в K5 («ROBOT-16 → В работе», «ROBOT-12 блокирует ROBOT-15»,
// «Схема захвата.pdf → v3», «PR #46 влит · ROBOT-11») и даты («только что», «сегодня, 12:41», «22 сент.»). Чистые
// функции; язык — ru* → ru, иначе en (как в «Задачах»); строки — блок C af22-living-map.ts (@ppm/brand).
import { resolvePpmLocale, type TPpmTranslationKey } from "@ppm/brand";
import { getPpmCanvasMap, parseSerializedPpmCanvasNode, type TPpmCanvasBinding } from "@ppm/canvas";
import type { Editor, TLShapeId } from "tldraw";
import { formatPpmPullRequestRef } from "@/components/ppm-tasks/evidence";
import type { TPpmBoardChange } from "@/services/ppm-canvas-changes.service";
import { fillCanvasTemplate, formatDueDate, OWN_NODE_KIND_KEYS } from "../canvas-grammar";
import { geoLabelKey } from "../canvas-toolkit-model";
import type { TPpmCanvasShape } from "../shape";
import { changeText } from "./changes-model";

const DAY_MS = 86_400_000;
const PPM_NODE_TYPE = "ppm-canvas-node" satisfies TPpmCanvasShape["type"];

export type TChangesT = (key: TPpmTranslationKey) => string;
export type TChangeIcon =
  | "added"
  | "assignee"
  | "changed"
  | "due"
  | "file"
  | "name"
  | "pr_merged"
  | "pr_opened"
  | "priority"
  | "relation"
  | "state";
export type TBoardChangeView = { detail: string; icon: TChangeIcon; text: string };
export type TDescribeChangeContext = {
  currentUserId: string;
  locale: string;
  /** Подпись вида объекта доски по его фигурам (для board.node.*); undefined — фигуры на доске уже нет. */
  nodeKindKey: (shapeIds: readonly string[]) => TPpmTranslationKey | undefined;
  /**
   * L-1: заголовок живой карточки по привязке её фигуры (nodeTitleForShapes, привязки доски из контекста карты);
   * undefined — привязки нет (своя карточка, нативная фигура, привязка ещё не пришла или уже снята).
   */
  nodeTitle: (shapeIds: readonly string[]) => string | undefined;
  now: number;
  t: TChangesT;
};

// Точные имена статусов Plane по умолчанию → русские (как getPpmStateDisplayName, ppm-design.ts); свои — как есть.
const DEFAULT_STATE_KEYS: Readonly<Record<string, TPpmTranslationKey>> = {
  Backlog: "ux.state.backlog",
  Todo: "ux.state.unstarted",
  "In Progress": "ux.state.started",
  Done: "ux.state.completed",
  Cancelled: "ux.state.cancelled",
  Triage: "ux.state.triage",
};

const PRIORITY_KEYS: Readonly<Record<string, TPpmTranslationKey>> = {
  urgent: "canvas.priority_urgent",
  high: "canvas.priority_high",
  medium: "canvas.priority_medium",
  low: "canvas.priority_low",
  none: "canvas.priority_none",
};

const RELATION_KEYS: Readonly<Record<string, TPpmTranslationKey>> = {
  blocking: "canvas.changes.relation_blocking",
  blocked_by: "canvas.changes.relation_blocked_by",
  relates_to: "canvas.changes.relation_relates_to",
  duplicate: "canvas.changes.relation_duplicate",
  implements: "canvas.changes.relation_implements",
  implemented_by: "canvas.changes.relation_implemented_by",
  start_before: "canvas.changes.relation_dependency",
  start_after: "canvas.changes.relation_dependency",
  finish_before: "canvas.changes.relation_dependency",
  finish_after: "canvas.changes.relation_dependency",
};

// Удалённая связь — прошедшим временем: «Связь удалена: ROBOT-12 блокировал ROBOT-15»; «связано» и прочее — без глагола.
const REMOVED_RELATION_KEYS: Readonly<Record<string, TPpmTranslationKey>> = {
  blocking: "canvas.changes.relation_blocking_removed",
  blocked_by: "canvas.changes.relation_blocked_by_removed",
  duplicate: "canvas.changes.relation_duplicate_removed",
  implements: "canvas.changes.relation_implements_removed",
  implemented_by: "canvas.changes.relation_implemented_by_removed",
  start_before: "canvas.changes.relation_dependency_removed",
  start_after: "canvas.changes.relation_dependency_removed",
  finish_before: "canvas.changes.relation_dependency_removed",
  finish_after: "canvas.changes.relation_dependency_removed",
};

const LIVE_NODE_KEYS: Readonly<Record<string, TPpmTranslationKey>> = {
  work_item_ref: "canvas.rail.work_item",
  page_ref: "canvas.rail.page",
  attachment_ref: "canvas.rail.file",
  vault_file_ref: "canvas.rail.file",
  pdf: "canvas.rail.file",
  image: "canvas.rail.file",
  reference: "canvas.rail.file",
  git_ref: "canvas.rail.git",
};

const lookup = (table: Readonly<Record<string, TPpmTranslationKey>>, key: string | null | undefined) =>
  key && Object.hasOwn(table, key) ? table[key] : undefined;

function clock(date: Date, language: string): string {
  return new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

function shortDate(date: Date, language: string, now: Date): string {
  return new Intl.DateTimeFormat(
    language,
    date.getFullYear() === now.getFullYear()
      ? { day: "numeric", month: "short" }
      : { day: "numeric", month: "short", year: "numeric" }
  ).format(date);
}

function calendarDaysBetween(earlier: Date, later: Date): number {
  return Math.round(
    (Date.UTC(later.getFullYear(), later.getMonth(), later.getDate()) -
      Date.UTC(earlier.getFullYear(), earlier.getMonth(), earlier.getDate())) /
      DAY_MS
  );
}

/** «когда» у события: только что · 5 мин. назад · сегодня, 09:05 · вчера, 18:40 · 22 сент. · 30 дек. 2025 г. */
export function formatChangeWhen(iso: string, locale: string, t: TChangesT, now: number): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "—";
  const language = resolvePpmLocale(locale);
  const delta = now - time;
  if (delta < 60_000) return t("canvas.changes.just_now");
  if (delta < 3_600_000)
    return new Intl.RelativeTimeFormat(language, { numeric: "always", style: "short" }).format(
      -Math.floor(delta / 60_000),
      "minute"
    );
  const date = new Date(time);
  const today = new Date(now);
  const days = calendarDaysBetween(date, today);
  if (days === 0) return fillCanvasTemplate(t("canvas.changes.today_at"), { time: clock(date, language) });
  if (days === 1) return fillCanvasTemplate(t("canvas.changes.yesterday_at"), { time: clock(date, language) });
  return shortDate(date, language, today);
}

/** Начало периода в заголовке: сегодня — время («с 12:41»), иначе дата («с 18 сент.»). */
export function formatChangesSince(iso: string, locale: string, now: number): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "—";
  const language = resolvePpmLocale(locale);
  const date = new Date(time);
  const today = new Date(now);
  return calendarDaysBetween(date, today) === 0 ? clock(date, language) : shortDate(date, language, today);
}

/** «6», а при обрезке ленты (200 событий или 30 дней) — «200+». */
export function formatChangesCount(count: number, truncated: boolean): string {
  return truncated ? `${count}+` : String(count);
}

/** Срок задачи: «YYYY-MM-DD…» → «29 сент.»; иное — как пришло. */
function formatChangeDate(value: string, locale: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? formatDueDate(match[1], locale) : value;
}

/** Подпись вида объекта доски: свои карточки — как в «Объектах», живые — по источнику, фигуры tldraw — по типу. */
export function nodeLabelKey(shapeType: string, ppmKind?: string | null, geo?: string | null): TPpmTranslationKey {
  if (shapeType === PPM_NODE_TYPE) {
    if (ppmKind && Object.hasOwn(OWN_NODE_KIND_KEYS, ppmKind))
      return OWN_NODE_KIND_KEYS[ppmKind as keyof typeof OWN_NODE_KIND_KEYS];
    return lookup(LIVE_NODE_KEYS, ppmKind) ?? "canvas.rail.object";
  }
  if (shapeType === "note") return "canvas.rail.sticky";
  if (shapeType === "text") return "canvas.rail.text";
  if (shapeType === "frame") return "canvas.rail.frame";
  if (shapeType === "arrow") return "canvas.shape.arrow";
  return (shapeType === "geo" && geo ? geoLabelKey(geo) : undefined) ?? "canvas.rail.object";
}

/**
 * Подпись живой фигуры доски (карточка PPM — по виду узла, geo — по форме). L-2: группа карты с ролью «sprint» —
 * «Рамка спринта»; секция карты и обычная группа — «Секция».
 */
export function boardNodeLabelKey(shape: { props: unknown; type: string }): TPpmTranslationKey {
  const props = shape.props as { geo?: unknown; node?: unknown };
  if (shape.type !== PPM_NODE_TYPE)
    return nodeLabelKey(shape.type, null, typeof props.geo === "string" ? props.geo : null);
  const parsed = typeof props.node === "string" ? parseSerializedPpmCanvasNode(props.node) : undefined;
  if (!parsed || (parsed.status !== "valid" && parsed.status !== "migrated")) return "canvas.rail.object";
  if (parsed.node.kind === "group" && getPpmCanvasMap(parsed.node)?.role === "sprint")
    return "canvas.changes.kind_sprint_frame";
  return nodeLabelKey(PPM_NODE_TYPE, parsed.node.kind);
}

/** Вид из самого события (S2: detail.field «kind» — вид узла PPM, «shape_type» — тип фигуры tldraw). */
function detailNodeLabelKey(detail: TPpmBoardChange["detail"]): TPpmTranslationKey | undefined {
  const value = changeText(detail.new);
  if (!value) return undefined;
  if (detail.field === "kind") return nodeLabelKey(PPM_NODE_TYPE, value);
  return detail.field === "shape_type" ? nodeLabelKey(value) : undefined;
}

/**
 * L-1 (живая проверка): у живой карточки своего заголовка нет (сервер отдаёт в entity.title node.title) — лента
 * подписывает её по привязке: задача — «228-4 · название», файл Хранилища, вложение и документ — название источника,
 * Git-объект — коротко (ревью FW-W): номер и название — «#46 · название» (номер PR — как в лотке, formatPpmPullRequestRef;
 * GitHub отдаёт его без «#»), у коммита — 7 знаков хеша, у ветки — её имя; вид («Git-объект») называет строка ленты.
 */
export function bindingTitle(binding: TPpmCanvasBinding): string | undefined {
  const { display } = binding.source;
  const title = display.title.trim();
  let identifier: string | null = null;
  if (binding.entity_type === "work_item") identifier = binding.source.identity.identifier?.trim() || null;
  else if ("object_type" in display) {
    const ref = display.ref.trim();
    if (display.object_type === "commit") identifier = display.commit_sha.slice(0, 7) || null;
    else if (display.object_type === "pull_request") identifier = formatPpmPullRequestRef(ref) ?? (ref || null);
    else identifier = ref || null;
  }
  const parts = [identifier, title].filter((part): part is string => Boolean(part));
  return parts.length === 0 ? undefined : parts[0] === parts[1] ? parts[0] : parts.join(" · ");
}

/** Заголовок по привязке первой фигуры события, у которой она есть (привязки доски — args.bindingsByShapeId). */
export function nodeTitleForShapes(
  bindings: ReadonlyMap<string, TPpmCanvasBinding>,
  shapeIds: readonly string[]
): string | undefined {
  for (const shapeId of shapeIds) {
    const binding = bindings.get(shapeId);
    const title = binding ? bindingTitle(binding) : undefined;
    if (title) return title;
  }
  return undefined;
}

export function nodeKindKeyForShapes(
  editor: Pick<Editor, "getShape">,
  shapeIds: readonly string[]
): TPpmTranslationKey | undefined {
  for (const shapeId of shapeIds) {
    const shape = editor.getShape(shapeId as TLShapeId);
    if (shape) return boardNodeLabelKey(shape);
  }
  return undefined;
}

function changeActor(item: TPpmBoardChange, context: TDescribeChangeContext): string | null {
  if (item.actor)
    return item.actor.id === context.currentUserId ? context.t("canvas.changes.actor_you") : item.actor.display_name;
  // Событие доски без автора — «на доске», как в спецификации. С S2a автор у фигур есть (автор версии доски, что их
  // добавила или изменила); его нет лишь у версий до S2a (запасной путь сервера) и у автора вне рабочего пространства.
  return item.kind === "board.node.added" || item.kind === "board.node.changed"
    ? context.t("canvas.changes.actor_board")
    : null;
}

type THeadline = Omit<TBoardChangeView, "detail"> & { prefix: string | null };

function headline(item: TPpmBoardChange, context: TDescribeChangeContext): THeadline {
  const { t } = context;
  const fill = (key: TPpmTranslationKey, values: Record<string, string>) => fillCanvasTemplate(t(key), values);
  const name = item.entity.identifier?.trim() || item.entity.title?.trim() || t("canvas.work_item");
  const next = changeText(item.detail.new);
  const previous = changeText(item.detail.old);
  switch (item.kind) {
    case "work_item.state": {
      const stateKey = lookup(DEFAULT_STATE_KEYS, next);
      return {
        icon: "state",
        prefix: null,
        text: next
          ? fill("canvas.changes.state", { item: name, value: stateKey ? t(stateKey) : next })
          : fill("canvas.changes.state_unknown", { item: name }),
      };
    }
    case "work_item.assignees":
      return {
        icon: "assignee",
        prefix: null,
        text: next
          ? fill("canvas.changes.assignee_added", { item: name, value: next })
          : fill("canvas.changes.assignee_removed", { item: name, value: previous ?? "—" }),
      };
    case "work_item.due":
      return {
        icon: "due",
        prefix: null,
        text: next
          ? fill("canvas.changes.due_set", { item: name, value: formatChangeDate(next, context.locale) })
          : fill("canvas.changes.due_removed", { item: name }),
      };
    case "work_item.priority": {
      const priorityKey = lookup(PRIORITY_KEYS, next) ?? "canvas.priority_none";
      return {
        icon: "priority",
        prefix: null,
        text: fill("canvas.changes.priority", { item: name, value: t(priorityKey) }),
      };
    }
    case "work_item.name":
      return {
        icon: "name",
        prefix: null,
        text: fill("canvas.changes.name", { item: name, value: next ?? item.entity.title?.trim() ?? "—" }),
      };
    case "work_item.relation": {
      const other = next ?? previous;
      // S2 не называет задачу, которую пользователь не видит (old и new — null): «связь со скрытой задачей».
      if (!other)
        return {
          icon: "relation",
          prefix: t("canvas.changes.relation_changed"),
          text: fill("canvas.changes.relation_hidden", { item: name }),
        };
      // Добавлена — настоящим временем и «новая связь в Задачах»; удалена — «Связь удалена: …» прошедшим и «в Задачах».
      const textKey = next
        ? (lookup(RELATION_KEYS, item.detail.field) ?? "canvas.changes.relation_other")
        : (lookup(REMOVED_RELATION_KEYS, item.detail.field) ?? "canvas.changes.relation_other_removed");
      return {
        icon: "relation",
        prefix: t(next ? "canvas.changes.relation_added" : "canvas.changes.relation_removed"),
        text: fill(textKey, { item: name, other }),
      };
    }
    case "git.pull_request.opened":
    case "git.pull_request.merged": {
      const merged = item.kind === "git.pull_request.merged";
      const pr = item.entity.identifier?.trim() || item.entity.title?.trim() || "—";
      const text = fill(merged ? "canvas.changes.pr_merged" : "canvas.changes.pr_opened", { pr });
      // S2: detail.new — задачи доски/спринта, связанные с PR («LMP-3, LMP-7»).
      const task = item.detail.field === "work_items" ? next : null;
      return { icon: merged ? "pr_merged" : "pr_opened", prefix: null, text: task ? `${text} · ${task}` : text };
    }
    case "vault.version": {
      const file = item.entity.title?.trim() || item.entity.identifier?.trim() || t("canvas.rail.file");
      return next
        ? {
            icon: "file",
            prefix: t("canvas.changes.version_new"),
            text: fill("canvas.changes.version", { file, value: next }),
          }
        : { icon: "file", prefix: null, text: fill("canvas.changes.version_unknown", { file }) };
    }
    case "board.node.added":
    case "board.node.changed": {
      const added = item.kind === "board.node.added";
      const kind = t(context.nodeKindKey(item.shape_ids) ?? detailNodeLabelKey(item.detail) ?? "canvas.rail.object");
      // L-1: заголовок привязки живой карточки → заголовок узла от сервера → только вид.
      const title = context.nodeTitle(item.shape_ids)?.trim() || item.entity.title?.trim();
      return {
        icon: added ? "added" : "changed",
        prefix: t(added ? "canvas.changes.chip_added" : "canvas.changes.chip_changed"),
        text: title && title !== kind ? fill("canvas.changes.node_titled", { kind, title }) : kind,
      };
    }
    default:
      return { icon: "changed", prefix: null, text: name };
  }
}

/** Строка ленты: значок, текст и «что · кто · когда» (K5). */
export function describeBoardChange(item: TPpmBoardChange, context: TDescribeChangeContext): TBoardChangeView {
  const { icon, prefix, text } = headline(item, context);
  const detail = [
    prefix,
    changeActor(item, context),
    formatChangeWhen(item.occurred_at, context.locale, context.t, context.now),
  ]
    .filter(Boolean)
    .join(" · ");
  return { detail, icon, text };
}
