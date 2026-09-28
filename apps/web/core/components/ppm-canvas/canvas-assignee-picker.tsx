/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// G2.1 · линия C: исполнители задачи на Холсте — живая карточка, карточка вида задач, инспектор. Прежний нативный
// select с multiple рисовался раскрытым списком всех участников прямо в карточке и налезал на неё. Теперь в карточке —
// аватарки (до 3 + «+N», имена во всплывающей подсказке) или «Не назначен»; нажатие открывает список участников с
// флажками (поиск — если участников больше 8, «Снять всех»). Изменение уходит тем же onChange → onPatch/onUpdate
// ({ assignee_ids }), без прав — только просмотр.
//
// Список — портал в свой слой в body: вне рамки карточки (overflow: hidden) и вне масштаба холста (слой фигур tldraw
// масштабируется transform). Позиция — от getBoundingClientRect кнопки, пересчёт каждый кадр, пока список открыт:
// холст можно панорамировать и масштабировать, список едет за кнопкой. Кнопку не видно — список закрывается: ушла за
// окно или за край обрезающего предка (колонка «Доски задач», прокрутка инспектора, холст под шапкой), скрыта
// (visibility: hidden у вкладки другой доски — checkVisibility) или её закрыла панель холста (рейка v2, инспектор).
//
// События (C2). Корень React — document (hydrateRoot), поэтому stopPropagation в обработчиках React не спасает от
// hotkeys-js tldraw: он слушает body, а body — раньше document. hotkeys-js пропускает только текстовые поля, select и
// textarea; флажок или кнопка в фокусе отдали бы ему Backspace (удалить выделенные фигуры), ⌘Z, буквы инструментов.
// Поэтому: (1) слой списка — отдельный контейнер портала: React слушает его сам, а нативные клавиши дальше слоя не
// всплывают; (2) кнопка на карточке гасит нативные клавиши на себе (кроме Esc — он по-прежнему снимает выделение
// холста и закрывает инспектор), как их не видел прежний select; (3) корень списка гасит всплытие указателя, касаний,
// колёсика и клавиш по дереву React — до .tl-canvas (useCanvasEvents) и до инспектора с его Esc они не доходят;
// (4) вырезать/копировать/вставить tldraw слушает на document — пока фокус на кнопке или в списке, их перехватывает
// слушатель в фазе захвата (createAssigneeClipboardGuard). Фокус не должен падать в body, пока список открыт: список
// не сжимается до закрытия (openAssigneeSession), «Снять всех» не становится disabled, а если фокус всё же ушёл «в
// никуда» — он возвращается в корень списка (focusout в Chrome; в WebKit удаление элемента молчит — проверка каждый кадр).
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, LoaderCircle, Search } from "lucide-react";
import { getFileURL } from "@plane/utils";
import type { TPpmTranslationKey } from "@ppm/brand";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { fillCanvasTemplate } from "./canvas-grammar";
// oxlint-disable-next-line import/no-unassigned-import -- G2.1 C: кнопка исполнителей и её список (портал), v1 и v2
import "./canvas-assignee-picker.css";

export type TPpmCanvasAssignee = { id: string; display_name: string; avatar_url: string | null };

export type TPpmAssigneeTexts = {
  clear: string;
  empty: string;
  label: string;
  more: (names: string) => string;
  noMatches: string;
  saving: string;
  search: string;
  summary: (names: string) => string;
  summaryNone: string;
  unassigned: string;
};

/** Сколько аватарок видно на кнопке; остальные — «+N». */
export const PPM_ASSIGNEE_AVATAR_LIMIT = 3;
/** Поиск в списке — только когда участников больше. */
export const PPM_ASSIGNEE_SEARCH_THRESHOLD = 8;
/** Высота списка по макету; меньше — если до края окна ближе. */
const POPOVER_MAX_HEIGHT = 352;
const POPOVER_MIN_HEIGHT = 120;
const POPOVER_MARGIN = 8;
const POPOVER_GAP = 4;
const FOCUSABLE = 'input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function assigneeTexts(translate: (key: TPpmTranslationKey) => string): TPpmAssigneeTexts {
  return {
    clear: translate("canvas.assignees_clear"),
    empty: translate("canvas.assignees_empty"),
    label: translate("canvas.work_item_assignees"),
    more: (names) => fillCanvasTemplate(translate("canvas.assignees_more"), { names }),
    noMatches: translate("canvas.assignees_no_matches"),
    saving: translate("canvas.assignees_saving"),
    search: translate("canvas.assignees_search"),
    summary: (names) => fillCanvasTemplate(translate("canvas.assignees_summary"), { names }),
    summaryNone: translate("canvas.assignees_summary_none"),
    unassigned: translate("canvas.unassigned"),
  };
}

/** Буквы слова по кодовым точкам (эмодзи не рвётся пополам), без цифр, скобок, прочих знаков и эмодзи. */
function assigneeWordLetters(word: string): string[] {
  return Array.from(word).filter((char) => /\p{L}/u.test(char));
}

/**
 * «Иван Петров» → «ИП», «ivan.petrov» → «IP», одно слово («олег») → «О»: буква слова — её первая *буква*, а не первый
 * символ, поэтому «Посторонний (демо)» → «ПД», а не «П(» (у «(демо)» первая буква — «д», скобка не в счёт). Слово без
 * единой буквы (только цифры/скобки/эмодзи) пропускается и во «первые два слова» не входит — «Сотрудник 1 ROBOT» →
 * «СR», не «С1». Букв нет вовсе ни в одном слове — первый символ e-mail, если он есть, иначе «?».
 */
export function assigneeInitials(name: string, email?: string | null): string {
  const initials = name
    .trim()
    .split(/[\s._-]+/u)
    .map(assigneeWordLetters)
    .filter((letters) => letters.length > 0)
    .slice(0, 2)
    .map((letters) => letters[0])
    .join("")
    .toLocaleUpperCase();
  if (initials) return initials;
  const emailChar = email?.trim().charAt(0);
  return emailChar ? emailChar.toLocaleUpperCase() : "?";
}

export function assigneeStack<T>(assignees: readonly T[], limit = PPM_ASSIGNEE_AVATAR_LIMIT) {
  return { visible: assignees.slice(0, limit), hidden: assignees.slice(limit) };
}

export function assigneeNames(assignees: readonly Pick<TPpmCanvasAssignee, "display_name">[]): string {
  return assignees.map((assignee) => assignee.display_name).join(", ");
}

/**
 * Участники проекта и назначенные, которых среди них нет (ушёл из проекта): прежний select молча терял таких при
 * любом изменении — здесь они остаются в списке отмеченными, снять их можно явно.
 */
export function assigneeChoices(
  options: readonly TPpmCanvasAssignee[],
  assigned: readonly TPpmCanvasAssignee[]
): TPpmCanvasAssignee[] {
  const known = new Set(options.map((option) => option.id));
  return [...options, ...assigned.filter((assignee) => !known.has(assignee.id))];
}

export function shouldShowAssigneeSearch(count: number): boolean {
  return count > PPM_ASSIGNEE_SEARCH_THRESHOLD;
}

function normalizeAssigneeText(value: string): string {
  return value.trim().toLocaleLowerCase().replaceAll("ё", "е");
}

export function filterAssigneeChoices(choices: readonly TPpmCanvasAssignee[], query: string): TPpmCanvasAssignee[] {
  const needle = normalizeAssigneeText(query);
  if (!needle) return [...choices];
  return choices.filter((choice) => normalizeAssigneeText(choice.display_name).includes(needle));
}

/** Выбор добавляет в конец, снятие убирает; остальные id (в том числе незнакомые) остаются на месте. */
export function toggleAssigneeId(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id];
}

/** Открытый список: его строки и показан ли поиск. */
export type TPpmAssigneeSession = { choices: readonly TPpmCanvasAssignee[]; search: boolean };

/**
 * Список открыли — строки на этот момент. До закрытия он не сжимается: снятый бывший участник (его нет среди
 * участников проекта) пропал бы из списка после ответа сервера вместе с фокусом на его флажке, а поиск — при переходе
 * через 9 → 8 участников; фокус упал бы в body, и Esc не сработал бы, а Backspace/⌘Z ушли бы холсту.
 */
export function openAssigneeSession(choices: readonly TPpmCanvasAssignee[]): TPpmAssigneeSession {
  return { choices: [...choices], search: shouldShowAssigneeSearch(choices.length) };
}

/**
 * Строки открытого списка и текущие: прежние остаются на своих местах (имя и фото — свежие), новые — в конец, поиск,
 * раз показанный, остаётся. Ничего не изменилось — тот же объект (обновление при отрисовке не зацикливается).
 */
export function syncAssigneeSession(
  session: TPpmAssigneeSession,
  current: readonly TPpmCanvasAssignee[]
): TPpmAssigneeSession {
  const fresh = new Map(current.map((choice) => [choice.id, choice]));
  const known = new Set(session.choices.map((choice) => choice.id));
  let changed = false;
  const kept = session.choices.map((choice) => {
    const next = fresh.get(choice.id);
    if (!next || (next.display_name === choice.display_name && next.avatar_url === choice.avatar_url)) return choice;
    changed = true;
    return next;
  });
  const added = current.filter((choice) => !known.has(choice.id));
  if (!changed && added.length === 0) return session;
  const choices = [...kept, ...added];
  return { choices, search: session.search || shouldShowAssigneeSearch(choices.length) };
}

/** Черновик выбора: отправленный, но ещё не вернувшийся с сервера набор; busy и valueKey — что было при прошлой сверке. */
export type TPpmAssigneeDraft = { busy: boolean; ids: readonly string[] | null; valueKey: string };
export type TPpmAssigneeDraftAction =
  | { type: "close" }
  | { type: "commit"; ids: readonly string[] }
  | { busy: boolean; type: "sync"; valueKey: string };

export function createAssigneeDraft(valueKey: string, busy: boolean): TPpmAssigneeDraft {
  return { busy, ids: null, valueKey };
}

/**
 * commit — выбор виден сразу, не дожидаясь сервера; sync — сверка с задачей: пришло новое значение (ответ или правка
 * другого пользователя) или сохранение закончилось (в том числе ошибкой — видно прежнее) — черновик больше не нужен;
 * close — список закрыли: запрос ещё идёт — черновик ждёт ответа, иначе сразу к значению задачи. Без изменений —
 * тот же объект.
 */
export function assigneeDraftReducer(draft: TPpmAssigneeDraft, action: TPpmAssigneeDraftAction): TPpmAssigneeDraft {
  if (action.type === "commit") return { ...draft, ids: [...action.ids] };
  if (action.type === "close") return draft.busy || draft.ids === null ? draft : { ...draft, ids: null };
  if (draft.busy === action.busy && draft.valueKey === action.valueKey) return draft;
  const settled = draft.valueKey !== action.valueKey || (draft.busy && !action.busy);
  return { busy: action.busy, ids: settled ? null : draft.ids, valueKey: action.valueKey };
}

/**
 * Что делают флажок и «Снять всех». Пока идёт сохранение (busy), ничего: версия задачи ещё старая — второй запрос
 * получил бы 409. Флажки при этом не disabled (только aria-disabled): disabled-флажок в фокусе отдал бы фокус body.
 */
export function assigneeSelectionActions(
  selected: readonly string[],
  commit: (assigneeIds: string[]) => void,
  busy: boolean
) {
  return {
    toggle: (id: string) => {
      if (!busy) commit(toggleAssigneeId(selected, id));
    },
    clear: () => {
      if (!busy && selected.length > 0) commit([]);
    },
  };
}

export type TPpmAssigneeTriggerKey = "close" | "open" | "pass" | "stop" | "swallow";

/**
 * Клавиша на кнопке карточки: Esc идёт дальше (снять выделение холста, закрыть инспектор), остальное гасится.
 * Backspace/Delete ещё и без действия по умолчанию («swallow»): WebKit со старой настройкой уводит по ним «назад».
 */
export function assigneeTriggerKey(code: string, open: boolean): TPpmAssigneeTriggerKey {
  if (code === "Escape") return open ? "close" : "pass";
  if (code === "Backspace" || code === "Delete") return "swallow";
  if (!open && (code === "ArrowDown" || code === "ArrowUp")) return "open";
  return "stop";
}

export type TPpmAssigneeMenuKey =
  | "close"
  | "first"
  | "last"
  | "next"
  | "prev"
  | "swallow"
  | "tab-next"
  | "tab-prev"
  | "toggle";

/**
 * Клавиши списка (e.code — русская раскладка). Фокус: search — поле поиска, option — флажок, other — «Снять всех».
 * Home/End и Enter — только на флажке (в поиске это курсор и ввод); Backspace/Delete вне поиска — без действия.
 */
export function assigneeMenuKey(
  code: string,
  shiftKey: boolean,
  focus: "option" | "other" | "search"
): TPpmAssigneeMenuKey | undefined {
  const onOption = focus === "option";
  switch (code) {
    case "Escape":
      return "close";
    case "Tab":
      return shiftKey ? "tab-prev" : "tab-next";
    case "ArrowDown":
      return "next";
    case "ArrowUp":
      return "prev";
    case "Home":
      return onOption ? "first" : undefined;
    case "End":
      return onOption ? "last" : undefined;
    case "Enter":
    case "NumpadEnter":
      return onOption ? "toggle" : undefined;
    case "Backspace":
    case "Delete":
      return focus === "search" ? undefined : "swallow";
    default:
      return undefined;
  }
}

/** Следующий по кругу; -1 (фокуса в списке нет) — первый или последний. */
export function cycleAssigneeIndex(index: number, count: number, step: 1 | -1): number {
  if (count <= 0) return -1;
  if (index < 0) return step > 0 ? 0 : count - 1;
  return (index + step + count) % count;
}

type TRectLike = { bottom: number; left: number; right: number; top: number };
type TSize = { height: number; width: number };

/**
 * Под кнопкой, левым краем к её левому краю; не влезает вниз и сверху места больше — над ней. Всегда в пределах окна:
 * кнопка на холсте может быть крошечной (масштаб 25 %) или огромной — список остаётся обычного размера.
 */
export function assigneePopoverPlacement(anchor: TRectLike, size: TSize, viewport: TSize) {
  const below = viewport.height - anchor.bottom - POPOVER_GAP - POPOVER_MARGIN;
  const above = anchor.top - POPOVER_GAP - POPOVER_MARGIN;
  const side: "above" | "below" = size.height <= below || below >= above ? "below" : "above";
  const room = Math.min(
    Math.max(side === "below" ? below : above, POPOVER_MIN_HEIGHT),
    viewport.height - POPOVER_MARGIN * 2
  );
  const height = Math.min(size.height, room);
  const top = side === "below" ? anchor.bottom + POPOVER_GAP : anchor.top - POPOVER_GAP - height;
  return {
    left: Math.max(POPOVER_MARGIN, Math.min(anchor.left, viewport.width - POPOVER_MARGIN - size.width)),
    maxHeight: room,
    side,
    top: Math.max(POPOVER_MARGIN, Math.min(top, viewport.height - POPOVER_MARGIN - height)),
  };
}

/**
 * Видимая часть кнопки: пересечение её прямоугольника с окном и с каждым обрезающим предком (колонка «Доски задач» с
 * overflow: auto, прокрутка инспектора, холст tldraw с overflow: clip — под шапкой и рейкой v1); пусто — null, список
 * закрыть. Скрытую вкладку доски (visibility: hidden) по прямоугольнику не узнать — её ловит checkVisibility.
 */
export function assigneeVisibleRect(rect: TRectLike, clips: readonly TRectLike[], viewport: TSize): TRectLike | null {
  let { bottom, left, right, top } = rect;
  for (const clip of [...clips, { bottom: viewport.height, left: 0, right: viewport.width, top: 0 }]) {
    bottom = Math.min(bottom, clip.bottom);
    left = Math.max(left, clip.left);
    right = Math.min(right, clip.right);
    top = Math.max(top, clip.top);
  }
  return bottom > top && right > left ? { bottom, left, right, top } : null;
}

/** Обрезает ли предок потомков: overflow ≠ visible или contain: paint (strict, content). */
export function isClippingStyle(style: { contain: string; overflowX: string; overflowY: string }): boolean {
  return (
    style.overflowX !== "visible" || style.overflowY !== "visible" || /\b(?:paint|strict|content)\b/.test(style.contain)
  );
}

type TAncestor = { matches: (selector: string) => boolean; parentElement: unknown };

/** Обрезающие предки кнопки — до оболочки холста включительно (дальше — оболочка Plane, её не касаемся). */
export function assigneeClipAncestors<T extends TAncestor>(element: T, clips: (ancestor: T) => boolean): T[] {
  const result: T[] = [];
  for (let ancestor = element.parentElement as T | null; ancestor; ancestor = ancestor.parentElement as T | null) {
    if (clips(ancestor)) result.push(ancestor);
    if (ancestor.matches(".ppm-canvas-shell")) break;
  }
  return result;
}

/** Три точки средней линии видимой части кнопки: у краёв и в центре. */
export function assigneeMidline(rect: TRectLike): Array<[number, number]> {
  const y = (rect.top + rect.bottom) / 2;
  const width = rect.right - rect.left;
  return [0.1, 0.5, 0.9].map((share) => [rect.left + width * share, y]);
}

type TZone = { contains: (node: Node | null) => boolean } | null | undefined;

/**
 * Кнопку закрыла панель холста — рейка v2 (она поверх холста и его не обрезает), инспектор, «Живая карта»,
 * уведомление: во всех трёх точках средней линии сверху элемент рабочей области холста, но не сама кнопка, не список и
 * не поверхность tldraw (фигуры, выделение, кнопки холста). Частично закрытая кнопка — не закрыта (по ней и нажимали);
 * всплывающие окна вне холста не судим.
 */
export function isAssigneeAnchorCovered(
  hits: readonly (Node | null)[],
  zones: { layer: TZone; surface: TZone; trigger: TZone; workspace: TZone }
): boolean {
  if (!zones.workspace || hits.length === 0) return false;
  return hits.every(
    (hit) =>
      hit !== null &&
      !zones.trigger?.contains(hit) &&
      !zones.layer?.contains(hit) &&
      !zones.surface?.contains(hit) &&
      Boolean(zones.workspace?.contains(hit))
  );
}

export type TPpmAssigneeAnchorState = { covered: boolean; visible: TRectLike | null };

/**
 * Видна ли кнопка, с пересчётом только при сдвиге: тот же прямоугольник кнопки (с точностью до пикселя, как у
 * размещения списка), то же окно и та же видимость — прежний ответ, без прямоугольников обрезающих предков и трёх
 * elementFromPoint на каждый кадр. Колонку или инспектор прокрутили, холст сдвинули — прямоугольник кнопки меняется.
 */
export function createAssigneeAnchorWatch(measure: {
  clipRects: () => readonly TRectLike[];
  hitsAt: (points: Array<[number, number]>) => readonly (Node | null)[];
  zones: { layer: TZone; surface: TZone; trigger: TZone; workspace: TZone };
}) {
  let key = "";
  let state: TPpmAssigneeAnchorState = { covered: false, visible: null };
  return (rect: TRectLike, shown: boolean, viewport: TSize): TPpmAssigneeAnchorState => {
    const next = [shown ? 1 : 0, rect.left, rect.top, rect.right, rect.bottom]
      .map((value) => Math.round(value))
      .concat(viewport.width, viewport.height)
      .join(":");
    if (next === key) return state;
    key = next;
    const visible = shown ? assigneeVisibleRect(rect, measure.clipRects(), viewport) : null;
    const covered =
      visible !== null && isAssigneeAnchorCovered(measure.hitsAt(assigneeMidline(visible)), measure.zones);
    state = { covered, visible };
    return state;
  };
}

/**
 * Фокус ушёл «в никуда» при открытом списке (строку или кнопку убрали, элемент стал неактивным) — вернуть его в корень
 * списка (tabIndex=-1): с body клавиши и буфер обмена ушли бы холсту, Backspace удалил бы выделенную карточку.
 * Окно без фокуса (переключились в другое приложение), закрытый или убранный список — не трогаем.
 */
export function shouldReclaimAssigneeFocus(
  doc: { activeElement: Element | null; body: Element | null; hasFocus: () => boolean },
  root: { isConnected: boolean } | null,
  open: boolean
): boolean {
  if (!open || !root?.isConnected || !doc.hasFocus()) return false;
  return !doc.activeElement || doc.activeElement === doc.body;
}

/** Ключ кнопки в «Доске задач»: id узла и id задачи — две доски задач с одной задачей фокус друг у друга не берут. */
export function workItemsViewAnchorKey(viewShapeId: string, entityId: string): string {
  return `work-items-view:${viewShapeId}:${entityId}`;
}

/**
 * Кнопка той же задачи на новом месте: карточку «Доски задач» пересоздают при переносе между колонками (группировка по
 * исполнителю — после каждой правки исполнителей). Ищем только в корне своей доски (.ppm-canvas-shell): на другой
 * доске может быть узел с тем же id. Фокус — первой кнопке, которая его приняла (скрытая вкладка — нет).
 */
export function findAssigneeAnchor(
  root: { querySelectorAll: (selector: string) => NodeListOf<HTMLElement> },
  anchorKey: string,
  doc: { activeElement: Element | null }
): HTMLElement | null {
  for (const element of Array.from(root.querySelectorAll("button[data-ppm-assignee-anchor]"))) {
    if (element.dataset.ppmAssigneeAnchor !== anchorKey) continue;
    element.focus({ preventScroll: true });
    if (doc.activeElement === element) return element;
  }
  return null;
}

export type TPpmAssigneeClipboardVerdict = "allow" | "block" | "outside";

/**
 * Вырезать/копировать/вставить при фокусе в выборе: tldraw слушает их на document и молчит, только когда фокус в
 * input/select/textarea — на кнопке или «Снять всех» ⌘X вырезал бы выделенную карточку, ⌘V вставил бы на холст.
 * Поле поиска — обычная правка текста (allow); фокус вне выбора — не наше дело (outside).
 */
export function assigneeClipboardVerdict(
  active: Node | null,
  zones: { popover: TZone; search: Node | null; trigger: TZone }
): TPpmAssigneeClipboardVerdict {
  if (!active || !(zones.trigger?.contains(active) || zones.popover?.contains(active))) return "outside";
  return active === zones.search ? "allow" : "block";
}

const CLIPBOARD_EVENTS = ["copy", "cut", "paste"] as const;

/**
 * Перехват в фазе захвата на document — раньше слушателей tldraw (они на document в фазе всплытия): stopPropagation
 * не пускает событие дальше, действие по умолчанию (копирование выделенного текста) не трогаем. Слушатели стоят, только
 * пока фокус на кнопке или в списке: arm() — фокус пришёл; снимаются сами, когда фокус ушёл на другой элемент (focusin)
 * или событие застало его вне выбора, и disarm() — при размонтировании.
 */
export function createAssigneeClipboardGuard(
  target: Pick<Document, "addEventListener" | "removeEventListener">,
  verdict: () => TPpmAssigneeClipboardVerdict
) {
  let armed = false;
  const onClipboard = (event: Event) => {
    const current = verdict();
    if (current === "block") event.stopPropagation();
    else if (current === "outside") disarm();
  };
  const onFocusIn = () => {
    if (verdict() === "outside") disarm();
  };
  function arm() {
    if (armed) return;
    armed = true;
    for (const type of CLIPBOARD_EVENTS) target.addEventListener(type, onClipboard, true);
    target.addEventListener("focusin", onFocusIn, true);
  }
  function disarm() {
    if (!armed) return;
    armed = false;
    for (const type of CLIPBOARD_EVENTS) target.removeEventListener(type, onClipboard, true);
    target.removeEventListener("focusin", onFocusIn, true);
  }
  return { arm, disarm, isArmed: () => armed };
}

/** Нажатие вне списка, кнопки и подписей кнопки (щелчок по подписи снова нажал бы кнопку — список бы моргнул). */
export function isOutsideAssigneePicker(target: unknown, zones: readonly TZone[]): boolean {
  if (!target) return false;
  return !zones.some((zone) => zone?.contains(target as Node));
}

const stopReactEvent = (event: { stopPropagation: () => void }) => event.stopPropagation();

/** Корень списка: указатель, касания, колёсико, клики и перетаскивание не всплывают по дереву React до холста. */
export const PPM_ASSIGNEE_LAYER_GUARDS = {
  onClick: stopReactEvent,
  onContextMenu: stopReactEvent,
  onDoubleClick: stopReactEvent,
  onDragOver: stopReactEvent,
  onDragStart: stopReactEvent,
  onDrop: stopReactEvent,
  onKeyUp: stopReactEvent,
  onMouseDown: stopReactEvent,
  onMouseUp: stopReactEvent,
  onPointerCancel: stopReactEvent,
  onPointerDown: stopReactEvent,
  onPointerMove: stopReactEvent,
  onPointerUp: stopReactEvent,
  onTouchEnd: stopReactEvent,
  onTouchMove: stopReactEvent,
  onTouchStart: stopReactEvent,
  onWheel: stopReactEvent,
} as const;

const LAYER_KEY_EVENTS = ["keydown", "keypress", "keyup"] as const;

function stopNativeEvent(event: Event) {
  event.stopPropagation();
}

/**
 * Слой списка — свой контейнер портала в body. React вешает свои слушатели и на него: обработчики React внутри списка
 * работают как обычно, а нативные клавиши дальше слоя не всплывают — до body (hotkeys-js tldraw), document и window.
 */
export function createAssigneeLayer(ownerDocument: Document): HTMLDivElement {
  const layer = ownerDocument.createElement("div");
  layer.className = "ppm-assignee-layer";
  layer.setAttribute("data-ppm-assignee-layer", "");
  for (const type of LAYER_KEY_EVENTS) layer.addEventListener(type, stopNativeEvent);
  return layer;
}

function hideBrokenImage(event: { currentTarget: { hidden: boolean } }) {
  event.currentTarget.hidden = true;
}

/**
 * Аватарка: инициалы всегда под фото — не загрузилось фото, видны инициалы. decorative — в строке списка, где имя
 * написано рядом: без подсказки и скрыта от скринридера (имя флажка — только имя участника).
 */
export function PpmAssigneeAvatar({
  assignee,
  decorative = false,
}: {
  assignee: TPpmCanvasAssignee;
  decorative?: boolean;
}) {
  const src = assignee.avatar_url ? getFileURL(assignee.avatar_url) : undefined;
  return (
    <span
      aria-hidden={decorative || undefined}
      className="ppm-assignee-avatar"
      title={decorative ? undefined : assignee.display_name}
    >
      <span aria-hidden="true">{assigneeInitials(assignee.display_name)}</span>
      {src && <img alt="" decoding="async" draggable={false} src={src} onError={hideBrokenImage} />}
    </span>
  );
}

export function PpmAssigneeStack({
  assignees,
  texts,
}: {
  assignees: readonly TPpmCanvasAssignee[];
  texts: TPpmAssigneeTexts;
}) {
  if (assignees.length === 0) return <span className="ppm-assignee-empty">{texts.unassigned}</span>;
  const { hidden, visible } = assigneeStack(assignees);
  return (
    <span className="ppm-assignee-stack">
      {visible.map((assignee) => (
        <PpmAssigneeAvatar key={assignee.id} assignee={assignee} />
      ))}
      {hidden.length > 0 && (
        <span className="ppm-assignee-more" title={texts.more(assigneeNames(hidden))}>{`+${hidden.length}`}</span>
      )}
    </span>
  );
}

export type TPpmAssigneeMenuProps = {
  busy: boolean;
  /** Участники после поиска. */
  choices: readonly TPpmCanvasAssignee[];
  id: string;
  query: string;
  rootRef?: Ref<HTMLDivElement>;
  searchRef?: Ref<HTMLInputElement>;
  selectedIds: readonly string[];
  showSearch: boolean;
  texts: TPpmAssigneeTexts;
  /** Участников до поиска: 0 — «в проекте пока нет участников», иначе «никого не нашли». */
  total: number;
  /** Фокус ушёл из списка (focusout корня): страховка фокуса и перехват буфера обмена. */
  onBlur?: (event: ReactFocusEvent<HTMLDivElement>) => void;
  onClear: () => void;
  /** Фокус пришёл в список (focusin корня). */
  onFocus?: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onQuery: (query: string) => void;
  onToggle: (id: string) => void;
};

/**
 * Список (вид без хуков). role="dialog" без aria-modal: немодальное всплывающее окно с поиском, флажками и кнопкой.
 * data-ppm-canvas-modal — гард клавиш workspace.tsx: пока список открыт, однобуквенные инструменты рейки, ⌘K и Esc
 * холста не срабатывают вместо списка (как у выбора документа и файла).
 */
export function PpmAssigneeMenu(props: TPpmAssigneeMenuProps) {
  const { busy, choices, id, query, selectedIds, showSearch, texts, total } = props;
  const selected = new Set(selectedIds);
  return (
    <div
      ref={props.rootRef}
      {...PPM_ASSIGNEE_LAYER_GUARDS}
      aria-label={texts.label}
      className="ppm-assignee-popover"
      data-ppm-canvas-modal=""
      id={id}
      role="dialog"
      tabIndex={-1}
      onBlur={props.onBlur}
      onFocus={props.onFocus}
      onKeyDown={props.onKeyDown}
    >
      {showSearch && (
        <label className="ppm-assignee-popover__search">
          <Search aria-hidden="true" />
          <input
            ref={props.searchRef}
            aria-label={texts.search}
            autoComplete="off"
            data-ppm-assignee-nav="search"
            placeholder={texts.search}
            spellCheck={false}
            type="search"
            value={query}
            onChange={(event) => props.onQuery(event.currentTarget.value)}
          />
        </label>
      )}
      {choices.length > 0 ? (
        <ul aria-busy={busy || undefined} className="ppm-assignee-popover__list">
          {choices.map((assignee) => (
            <li key={assignee.id}>
              <label className="ppm-assignee-option">
                <input
                  aria-disabled={busy || undefined}
                  checked={selected.has(assignee.id)}
                  data-ppm-assignee-id={assignee.id}
                  data-ppm-assignee-nav="option"
                  type="checkbox"
                  onChange={() => props.onToggle(assignee.id)}
                />
                <PpmAssigneeAvatar assignee={assignee} decorative />
                <span className="ppm-assignee-option__name">{assignee.display_name}</span>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ppm-assignee-popover__note">{total === 0 ? texts.empty : texts.noMatches}</p>
      )}
      <footer className="ppm-assignee-popover__footer">
        <span className="ppm-assignee-popover__status" role="status">
          {busy && <LoaderCircle aria-hidden="true" />}
          {busy ? texts.saving : ""}
        </span>
        {/* Неактивна — только aria-disabled: disabled-кнопка в фокусе теряет его (Chrome уводит фокус в body). */}
        <button aria-disabled={busy || selectedIds.length === 0 || undefined} type="button" onClick={props.onClear}>
          {texts.clear}
        </button>
      </footer>
    </div>
  );
}

// Эффекты раскладки — только в браузере (renderToStaticMarkup в тестах их не ждёт).
const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Видна ли кнопка: display: none, visibility: hidden (вкладка другой доски) — нет. */
function isElementShown(element: HTMLElement): boolean {
  if (typeof element.checkVisibility === "function") {
    return element.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true });
  }
  return getComputedStyle(element).visibility !== "hidden";
}

export type TPpmAssigneePickerProps = {
  /**
   * Постоянный ключ задачи для кнопки: если карточку пересоздали (перенос между колонками «Доски задач»), а фокус был
   * на её кнопке или в списке, он переходит к кнопке той же задачи на новом месте, а не в body.
   */
  anchorKey?: string;
  assignees: readonly TPpmCanvasAssignee[];
  /** Идёт сохранение этой задачи: список открывается, флажки ждут. */
  busy?: boolean;
  /** Право менять исполнителей; без него — только просмотр (аватарки и подсказка, без кнопки и списка). */
  canEdit: boolean;
  /** id кнопки — для <label htmlFor> инспектора. */
  id?: string;
  options: readonly TPpmCanvasAssignee[];
  onChange: (assigneeIds: string[]) => void;
};

export function PpmAssigneePicker({
  anchorKey,
  assignees,
  busy = false,
  canEdit,
  id,
  options,
  onChange,
}: TPpmAssigneePickerProps) {
  const ppmT = usePpmTranslation();
  const texts = useMemo(() => assigneeTexts(ppmT), [ppmT]);
  const menuId = useId();
  // Открытый список (null — закрыт): его строки не сжимаются до закрытия.
  const [session, setSession] = useState<TPpmAssigneeSession | null>(null);
  const [query, setQuery] = useState("");
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const anchorKeyRef = useRef(anchorKey);
  anchorKeyRef.current = anchorKey;

  const valueIds = assignees.map((assignee) => assignee.id);
  const valueKey = valueIds.join(",");
  const choices = useMemo(() => assigneeChoices(options, assignees), [options, assignees]);

  // Сверка при отрисовке (а не в эффекте): иначе одна отрисовка без строки — и фокус на её флажке уже потерян.
  const liveSession = session ? syncAssigneeSession(session, choices) : null;
  if (liveSession !== session) setSession(liveSession);
  const open = liveSession !== null;
  const openRef = useRef(open);
  openRef.current = open;

  // Черновик выбора (assigneeDraftReducer): отправленный набор виден сразу, до ответа сервера.
  const [draftState, dispatchDraft] = useReducer(assigneeDraftReducer, undefined, () =>
    createAssigneeDraft(valueKey, busy)
  );
  const draft = assigneeDraftReducer(draftState, { busy, type: "sync", valueKey });
  if (draft !== draftState) dispatchDraft({ busy, type: "sync", valueKey });

  const listed = liveSession?.choices ?? choices;
  const selectedIds = draft.ids ?? valueIds;
  const shown = draft.ids
    ? draft.ids.flatMap((assigneeId) => listed.filter((choice) => choice.id === assigneeId))
    : [...assignees];
  const names = assigneeNames(shown);
  const summary = names ? texts.summary(names) : texts.summaryNone;
  const showSearch = liveSession?.search ?? false;
  const visibleChoices = showSearch ? filterAssigneeChoices(listed, query) : listed;

  // Перехват буфера обмена (createAssigneeClipboardGuard): стоит, только пока фокус на кнопке или в списке.
  const guardRef = useRef<ReturnType<typeof createAssigneeClipboardGuard> | null>(null);
  useEffect(() => {
    const guard = createAssigneeClipboardGuard(document, () =>
      assigneeClipboardVerdict(document.activeElement, {
        popover: popoverRef.current,
        search: searchRef.current,
        trigger: triggerRef.current,
      })
    );
    guardRef.current = guard;
    return () => {
      guard.disarm();
      guardRef.current = null;
    };
  }, []);
  const armClipboardGuard = () => guardRef.current?.arm();
  // Фокус ушёл из выбора не внутрь него: когда смена фокуса закончится, снять перехват, если фокус и правда вне выбора.
  const releaseClipboardGuard = (event: ReactFocusEvent) => {
    const next = event.relatedTarget;
    if (next instanceof Node && (triggerRef.current?.contains(next) || popoverRef.current?.contains(next))) return;
    queueMicrotask(() => {
      const verdict = assigneeClipboardVerdict(document.activeElement, {
        popover: popoverRef.current,
        search: searchRef.current,
        trigger: triggerRef.current,
      });
      if (verdict === "outside") guardRef.current?.disarm();
    });
  };

  // Строки открытого списка — текущие на момент открытия (обработчик клавиш кнопки живёт дольше одной отрисовки).
  const choicesRef = useRef(choices);
  choicesRef.current = choices;
  const openList = useCallback(() => setSession(openAssigneeSession(choicesRef.current)), []);
  const close = useCallback((restoreFocus: boolean) => {
    setSession(null);
    setQuery("");
    dispatchDraft({ type: "close" });
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!canEdit) setSession(null);
  }, [canEdit]);

  // Размонтирование, пока фокус был здесь (карточку пересоздали): отдать фокус кнопке той же задачи на новом месте.
  // Первым из эффектов раскладки — очистка идёт раньше, чем убирается слой списка, и видит, где был фокус.
  useBrowserLayoutEffect(
    () => () => {
      const key = anchorKeyRef.current;
      const active = document.activeElement;
      const wasHere = Boolean(active && (triggerRef.current?.contains(active) || popoverRef.current?.contains(active)));
      // Корень своей доски — пока кнопка ещё в DOM; закрыли саму доску — передавать некому.
      const board = triggerRef.current?.closest(".ppm-canvas-shell");
      if (!key || !wasHere || !board) return;
      queueMicrotask(() => {
        const current = document.activeElement;
        if (board.isConnected && (!current || current === document.body)) findAssigneeAnchor(board, key, document);
      });
    },
    []
  );

  // (1) Слой-портал списка — на время, пока список открыт.
  useBrowserLayoutEffect(() => {
    if (!open) return undefined;
    const element = createAssigneeLayer(document);
    document.body.append(element);
    setLayer(element);
    return () => {
      element.remove();
      setLayer(null);
    };
  }, [open]);

  // Каждый кадр, пока открыт: видна ли кнопка (холст панорамируют и масштабируют без событий scroll/resize), позиция
  // списка и страховка фокуса для WebKit (удаление элемента в фокусе там не шлёт focusout).
  useBrowserLayoutEffect(() => {
    if (!open || !layer) return undefined;
    let frame = 0;
    let last = "";
    let zonesFor: HTMLElement | null = null;
    let watch: ReturnType<typeof createAssigneeAnchorWatch> | null = null;
    const place = () => {
      const trigger = triggerRef.current;
      const popover = popoverRef.current;
      if (!trigger || !popover) return;
      if (zonesFor !== trigger || !watch) {
        zonesFor = trigger;
        const clips = assigneeClipAncestors(trigger, (ancestor) => isClippingStyle(getComputedStyle(ancestor)));
        watch = createAssigneeAnchorWatch({
          clipRects: () => clips.map((clip) => clip.getBoundingClientRect()),
          hitsAt: (points) => points.map(([x, y]) => document.elementFromPoint(x, y)),
          zones: {
            layer,
            surface: trigger.closest(".tl-container"),
            trigger,
            workspace: trigger.closest(".ppm-canvas-workspace") ?? trigger.closest(".ppm-canvas-shell"),
          },
        });
      }
      const viewport = { height: window.innerHeight, width: window.innerWidth };
      const { covered, visible } = watch(
        trigger.getBoundingClientRect(),
        trigger.isConnected && isElementShown(trigger),
        viewport
      );
      if (!visible || covered) {
        closeRef.current(popover.contains(document.activeElement));
        return;
      }
      // Страховка фокуса для WebKit: там удаление элемента в фокусе не шлёт focusout, фокус молча уходит в body.
      if (shouldReclaimAssigneeFocus(document, popover, true)) popover.focus({ preventScroll: true });
      const list = popover.querySelector<HTMLElement>(".ppm-assignee-popover__list");
      const natural = popover.offsetHeight - (list?.clientHeight ?? 0) + (list?.scrollHeight ?? 0);
      const placement = assigneePopoverPlacement(
        visible,
        { height: Math.min(natural, POPOVER_MAX_HEIGHT), width: popover.offsetWidth },
        viewport
      );
      const next = `${Math.round(placement.left)}:${Math.round(placement.top)}:${Math.floor(placement.maxHeight)}`;
      if (next !== last) {
        last = next;
        popover.style.setProperty("left", `${Math.round(placement.left)}px`);
        popover.style.setProperty("top", `${Math.round(placement.top)}px`);
        popover.style.setProperty("max-height", `${Math.min(POPOVER_MAX_HEIGHT, Math.floor(placement.maxHeight))}px`);
        popover.dataset.side = placement.side;
      }
      frame = window.requestAnimationFrame(place);
    };
    place();
    return () => window.cancelAnimationFrame(frame);
  }, [layer, open]);

  // Фокус — в поиск, иначе на первый отмеченный или первый флажок.
  useBrowserLayoutEffect(() => {
    if (!open || !layer) return;
    const popover = popoverRef.current;
    const target =
      searchRef.current ??
      popover?.querySelector<HTMLElement>('[data-ppm-assignee-nav="option"]:checked') ??
      popover?.querySelector<HTMLElement>("[data-ppm-assignee-nav]") ??
      popover;
    target?.focus({ preventScroll: true });
  }, [layer, open]);

  // Нажатие вне списка и кнопки закрывает список (фаза захвата — раньше, чем холст начнёт выделение).
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const trigger = triggerRef.current;
      const zones: TZone[] = [popoverRef.current, trigger, ...Array.from(trigger?.labels ?? [])];
      if (isOutsideAssigneePicker(event.target, zones)) closeRef.current(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  // (2) Кнопка на карточке: нативные клавиши не всплывают к hotkeys tldraw (кроме Esc), стрелки открывают список.
  useEffect(() => {
    const trigger = triggerRef.current;
    if (!canEdit || !trigger) return undefined;
    const onKey = (event: KeyboardEvent) => {
      const action = assigneeTriggerKey(event.code, openRef.current);
      if (action === "pass") return;
      event.stopPropagation();
      if (event.type !== "keydown") return;
      if (action === "swallow") event.preventDefault();
      if (action === "open") {
        event.preventDefault();
        openList();
      } else if (action === "close") {
        event.preventDefault();
        closeRef.current(true);
      }
    };
    trigger.addEventListener("keydown", onKey);
    trigger.addEventListener("keyup", onKey);
    return () => {
      trigger.removeEventListener("keydown", onKey);
      trigger.removeEventListener("keyup", onKey);
    };
  }, [canEdit, openList]);

  const commit = (next: string[]) => {
    dispatchDraft({ ids: next, type: "commit" });
    onChange(next);
  };
  const actions = assigneeSelectionActions(selectedIds, commit, busy);

  // (3) Клавиши списка: по дереву React дальше корня не идут (карточка, инспектор с его Esc).
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const nav = active?.dataset.ppmAssigneeNav;
    const action = assigneeMenuKey(event.code, event.shiftKey, nav === "option" || nav === "search" ? nav : "other");
    if (!action) return;
    event.preventDefault();
    const popover = event.currentTarget;
    if (action === "swallow") return;
    if (action === "close") {
      close(true);
      return;
    }
    if (action === "toggle") {
      active?.click();
      return;
    }
    if (action === "tab-next" || action === "tab-prev") {
      const focusables = Array.from(popover.querySelectorAll<HTMLElement>(FOCUSABLE));
      const index = cycleAssigneeIndex(
        active ? focusables.indexOf(active) : -1,
        focusables.length,
        action === "tab-next" ? 1 : -1
      );
      focusables[index]?.focus();
      return;
    }
    const items = Array.from(popover.querySelectorAll<HTMLElement>("[data-ppm-assignee-nav]"));
    if (action === "first" || action === "last") {
      const optionItems = items.filter((item) => item.dataset.ppmAssigneeNav === "option");
      optionItems[action === "first" ? 0 : optionItems.length - 1]?.focus();
      return;
    }
    const index = cycleAssigneeIndex(active ? items.indexOf(active) : -1, items.length, action === "next" ? 1 : -1);
    items[index]?.focus();
  };

  // Страховка фокуса (Chrome шлёт focusout с relatedTarget = null, когда элемент в фокусе убрали или он стал
  // неактивным): вернуть фокус в корень списка, как только смена фокуса закончится.
  const onMenuBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget !== null) return;
    const root = event.currentTarget;
    queueMicrotask(() => {
      if (shouldReclaimAssigneeFocus(document, root, openRef.current)) root.focus({ preventScroll: true });
    });
  };

  if (!canEdit) {
    return (
      <span className="ppm-assignee-trigger" data-readonly="" id={id} title={summary}>
        <span className="ppm-assignee-sr">{summary}</span>
        <span aria-hidden="true" className="ppm-assignee-trigger__stack">
          <PpmAssigneeStack assignees={shown} texts={texts} />
        </span>
      </span>
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={summary}
        className="ppm-assignee-trigger"
        data-ppm-assignee-anchor={anchorKey}
        id={id}
        title={summary}
        type="button"
        onBlur={releaseClipboardGuard}
        onClick={(event) => {
          event.stopPropagation();
          // Закрыть повторным нажатием — фокус на кнопку (Safari не ставит его на кнопку по щелчку, подпись — тоже).
          if (openRef.current) close(true);
          else openList();
        }}
        onFocus={armClipboardGuard}
        onPointerDown={stopReactEvent}
      >
        <PpmAssigneeStack assignees={shown} texts={texts} />
        <ChevronDown aria-hidden="true" className="ppm-assignee-trigger__chevron" />
      </button>
      {open &&
        layer &&
        createPortal(
          <PpmAssigneeMenu
            busy={busy}
            choices={visibleChoices}
            id={menuId}
            query={query}
            rootRef={popoverRef}
            searchRef={searchRef}
            selectedIds={selectedIds}
            showSearch={showSearch}
            texts={texts}
            total={listed.length}
            onBlur={(event) => {
              onMenuBlur(event);
              releaseClipboardGuard(event);
            }}
            onClear={actions.clear}
            onFocus={armClipboardGuard}
            onKeyDown={onMenuKeyDown}
            onQuery={setQuery}
            onToggle={actions.toggle}
          />,
          layer
        )}
    </>
  );
}
