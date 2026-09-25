import { createContext, useContext } from "react";
import { resolvePpmLocale } from "@ppm/brand";
import type { TPpmTranslationKey } from "@ppm/brand";
import type { TPpmCanvasOwnedNodeKind } from "@ppm/canvas";

// «Грамматика v2» холста — новый облик карточек, слой смысловых связей и инспектор. Включается только в рабочем
// пространстве (statusPlacement="footer") при html[data-ppm-design="v2"]. Минимальный режим
// (PPM_ANTYFLOW_SHELL_ENABLED=0) и облик v1 остаются в разметке волны 0.
export const PpmCanvasGrammarContext = createContext(false);

export function usePpmCanvasGrammarV2(): boolean {
  return useContext(PpmCanvasGrammarContext);
}

export function isCanvasGrammarV2(designV2: boolean, statusPlacement: "card" | "footer"): boolean {
  return designV2 && statusPlacement === "footer";
}

export type TPpmLiveSource = "tasks" | "knowledge" | "pages" | "code";

export const LIVE_SOURCE_LABEL_KEYS = {
  tasks: "project.tasks",
  knowledge: "project.knowledge",
  pages: "project.collaborative_pages",
  code: "project.code",
} as const satisfies Record<TPpmLiveSource, TPpmTranslationKey>;

export const LIVE_SOURCE_OPEN_KEYS = {
  tasks: "canvas.open_in_tasks",
  knowledge: "canvas.open_in_knowledge",
  pages: "canvas.open_in_pages",
  code: "canvas.open_in_code",
} as const satisfies Record<TPpmLiveSource, TPpmTranslationKey>;

export function liveSourceForEntity(
  entityType: "work_item" | "page" | "attachment" | "vault_file" | "repository" | "branch" | "commit" | "pull_request"
): TPpmLiveSource {
  if (entityType === "work_item" || entityType === "attachment") return "tasks";
  if (entityType === "vault_file") return "knowledge";
  if (entityType === "page") return "pages";
  return "code";
}

// «Сначала сужать, потом многоточие» без замеров в JS (notes/risk.md §3.5): эвристика по длине заголовка и ширине
// карточки — 14 px Plex Sans ≈ 7,6 px на знак, две строки, запас 10 %.
export function shouldNarrowTitle(title: string, cardWidth: number): boolean {
  return title.length > Math.floor(((cardWidth - 24) / 7.6) * 1.8);
}

// indicator() — метод ShapeUtil без React-контекста: радиус контура выделения совпадает с CSS карточки.
export function nodeIndicatorRadius(grammarV2: boolean, kind: string | undefined): number {
  if (!grammarV2) return 12;
  return kind === "group" || kind === "frame" ? 0 : 8;
}

// Своя карточка: подпись типа в sentence case (TOKENS §11, «Три семейства»). Ключ на kind — не переопределяет
// NATIVE_NODE_LABELS (shape.tsx), тот остаётся для aria-label textbox заголовка (e2e «Новая заметка»).
export const OWN_NODE_KIND_KEYS = {
  note: "canvas.kind_note",
  document: "canvas.kind_document",
  checklist: "canvas.kind_checklist",
  table: "canvas.kind_table",
  code: "canvas.kind_code",
  group: "canvas.kind_section",
  frame: "canvas.kind_frame",
  board_link: "canvas.kind_board_link",
  work_items_view: "canvas.kind_work_items_view",
  diagram: "canvas.kind_diagram",
  deck: "canvas.kind_deck",
} as const satisfies Record<TPpmCanvasOwnedNodeKind, TPpmTranslationKey>;

// Fills «{name}» placeholders of a UI string. A replacer function (not String#replace with a string) keeps user
// text literal: titles and queries with «$&», «$'» or «$$» are shown as typed. Unknown placeholders stay as they are.
export function fillCanvasTemplate(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : placeholder
  );
}

// Canvas strings exist only in ru and en (PPM_TRANSLATIONS): dates and plurals follow the UI language — ru* → ru,
// anything else → en — exactly as in «Задачи», never the raw locale (no German dates next to English labels).
export function sectionObjectCountKey(
  count: number,
  locale: string
): "canvas.section_objects_one" | "canvas.section_objects_few" | "canvas.section_objects_many" {
  const category = new Intl.PluralRules(resolvePpmLocale(locale)).select(count);
  if (category === "one") return "canvas.section_objects_one";
  if (category === "few") return "canvas.section_objects_few";
  return "canvas.section_objects_many";
}

// Due dates are plain calendar dates (YYYY-MM-DD): compare them as local calendar days, never through UTC midnight.
export function formatDueDate(dueDate: string, locale: string): string {
  const [year, month, day] = dueDate.split("-").map(Number);
  return new Intl.DateTimeFormat(resolvePpmLocale(locale), { day: "numeric", month: "short" }).format(
    new Date(year, month - 1, day)
  );
}

export function formatDueDateRelative(dueDate: string, locale: string, now: Date = new Date()): string {
  const [year, month, day] = dueDate.split("-").map(Number);
  const days = Math.round(
    (Date.UTC(year, month - 1, day) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86_400_000
  );
  return new Intl.RelativeTimeFormat(resolvePpmLocale(locale), { numeric: "auto" }).format(days, "day");
}

// Live card meta line «PDF · v3»: an unknown version is hidden, never printed as «v—».
export function liveCardMeta(extension: string | null | undefined, sourceVersion: string | null | undefined): string {
  const version = sourceVersion?.trim();
  return [extension ? extension.replace(/^\./, "").toUpperCase() : null, version ? `v${version}` : null]
    .filter(Boolean)
    .join(" · ");
}

// A card's name in lists (inspector links): the non-empty parts joined, or «Без названия» — never the raw tldraw id.
export function canvasNodeTitle(parts: readonly (string | null | undefined)[], untitled: string): string {
  return (
    parts
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(" · ") || untitled
  );
}
