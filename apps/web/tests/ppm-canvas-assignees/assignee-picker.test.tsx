// G2.1 · линия C: исполнители в карточках задач Холста — аватарки (до 3 + «+N») вместо раскрытого <select multiple>,
// выбор — выпадающим списком с флажками в портале. Env node без DOM: вид без хуков вызываем и «нажимаем» напрямую,
// разметку контейнера — строкой renderToStaticMarkup; поведение в браузере — стенд линии C (см. отчёт).
import { readFileSync } from "node:fs";
import { getPpmTranslation, PPM_TRANSLATIONS, type TPpmTranslationKey } from "@ppm/brand";
import { getFileURL } from "@plane/utils";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  assigneeChoices,
  assigneeInitials,
  assigneeMenuKey,
  assigneePopoverPlacement,
  assigneeSelectionActions,
  assigneeStack,
  assigneeTexts,
  assigneeTriggerKey,
  createAssigneeLayer,
  cycleAssigneeIndex,
  filterAssigneeChoices,
  assigneeVisibleRect,
  isOutsideAssigneePicker,
  PPM_ASSIGNEE_AVATAR_LIMIT,
  PPM_ASSIGNEE_LAYER_GUARDS,
  PpmAssigneeMenu,
  PpmAssigneePicker,
  PpmAssigneeStack,
  shouldShowAssigneeSearch,
  toggleAssigneeId,
  type TPpmCanvasAssignee,
} from "@/components/ppm-canvas/canvas-assignee-picker";
import { hostElements, textOf, type THostElement } from "./element-tree";

vi.mock("@/hooks/use-ppm-translation", async () => {
  const brand = await import("@ppm/brand");
  return { usePpmTranslation: () => (key: TPpmTranslationKey) => brand.getPpmTranslation("ru", key) };
});

const ru = (key: TPpmTranslationKey) => getPpmTranslation("ru", key);
const RU = assigneeTexts(ru);

const person = (n: number, display_name: string, avatar_url: string | null = null): TPpmCanvasAssignee => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  display_name,
  avatar_url,
});
const IVAN = person(1, "Иван Петров", "/api/assets/v2/static/ivan.png");
const ANNA = person(2, "Анна Смирнова");
const OLEG = person(3, "Олег Сидоров");
const MARIA = person(4, "Мария Котова");
const PETR = person(5, "Пётр Нилов");
const TEAM = [IVAN, ANNA, OLEG, MARIA, PETR];

const stack = (assignees: TPpmCanvasAssignee[]) =>
  renderToStaticMarkup(<PpmAssigneeStack assignees={assignees} texts={RU} />);
const count = (html: string, needle: string) => html.split(needle).length - 1;
const unescape = (html: string) => html.replaceAll("&quot;", '"').replaceAll("&amp;", "&");

function menu(overrides: Partial<Parameters<typeof PpmAssigneeMenu>[0]> = {}) {
  const props: Parameters<typeof PpmAssigneeMenu>[0] = {
    busy: false,
    choices: TEAM,
    id: "assignees-menu",
    query: "",
    selectedIds: [IVAN.id],
    showSearch: false,
    texts: RU,
    total: TEAM.length,
    onClear: vi.fn(),
    onKeyDown: vi.fn(),
    onQuery: vi.fn(),
    onToggle: vi.fn(),
    ...overrides,
  };
  return { props, tree: <PpmAssigneeMenu {...props} /> };
}

const checkboxOf = (elements: THostElement[], assignee: TPpmCanvasAssignee) =>
  elements.find((element) => element.type === "input" && element.props["data-ppm-assignee-id"] === assignee.id);
/** Обработчик элемента или ошибка теста, если его нет. */
function handler<T>(element: THostElement | undefined, name: string): T {
  const value = element?.props[name];
  if (typeof value !== "function") throw new Error(`No ${name} on ${element?.type ?? "missing element"}`);
  return value as T;
}
const clearButton = (elements: THostElement[]) =>
  elements.find((element) => element.type === "button" && textOf(element.props.children as never) === RU.clear);

describe("исполнители аватарками (C1)", () => {
  it("0 исполнителей — «Не назначен», без аватарок и «+N»", () => {
    const html = stack([]);
    expect(html).toContain("Не назначен");
    expect(count(html, "ppm-assignee-avatar")).toBe(0);
    expect(html).not.toContain("ppm-assignee-more");
  });

  it("1 и 3 исполнителя — столько же аватарок, без «+N»", () => {
    expect(count(stack([ANNA]), 'class="ppm-assignee-avatar"')).toBe(1);
    const three = stack([IVAN, ANNA, OLEG]);
    expect(count(three, 'class="ppm-assignee-avatar"')).toBe(3);
    expect(three).not.toContain("ppm-assignee-more");
    expect(three).not.toContain("Не назначен");
  });

  it("5 исполнителей — 3 аватарки и «+2», скрытые имена — в подсказке «+2»", () => {
    expect(PPM_ASSIGNEE_AVATAR_LIMIT).toBe(3);
    const html = unescape(stack(TEAM));
    expect(count(html, 'class="ppm-assignee-avatar"')).toBe(3);
    expect(html).toMatch(/class="ppm-assignee-more"[^>]*title="Ещё: Мария Котова, Пётр Нилов"[^>]*>\+2</);
    expect(assigneeStack(TEAM)).toEqual({ visible: [IVAN, ANNA, OLEG], hidden: [MARIA, PETR] });
  });

  it("имя каждого — во всплывающей подсказке аватарки, всех — в подсказке и имени кнопки", () => {
    const html = unescape(stack([IVAN, ANNA]));
    expect(html).toContain('title="Иван Петров"');
    expect(html).toContain('title="Анна Смирнова"');
    const picker = unescape(
      renderToStaticMarkup(<PpmAssigneePicker assignees={TEAM} canEdit options={TEAM} onChange={vi.fn()} />)
    );
    const names = "Иван Петров, Анна Смирнова, Олег Сидоров, Мария Котова, Пётр Нилов";
    expect(picker).toContain(`aria-label="Исполнители: ${names}"`);
    expect(picker).toContain(`title="Исполнители: ${names}"`);
  });

  it("инициалы — первые буквы двух слов имени (логин с точкой тоже), пустое имя — «?»", () => {
    expect(assigneeInitials("Иван Петров")).toBe("ИП");
    expect(assigneeInitials("  олег  ")).toBe("О");
    expect(assigneeInitials("ivan.petrov")).toBe("IP");
    expect(assigneeInitials("Анна Мария Смирнова")).toBe("АМ");
    expect(assigneeInitials("   ")).toBe("?");
  });

  it("фото — через getFileURL поверх инициалов (инициалы остаются, если фото не загрузится)", () => {
    const html = stack([IVAN]);
    expect(html).toContain(`src="${getFileURL(IVAN.avatar_url ?? "")}"`);
    expect(html).toMatch(/<span aria-hidden="true">ИП<\/span><img/);
    const image = hostElements(<PpmAssigneeStack assignees={[IVAN]} texts={RU} />).find((e) => e.type === "img");
    const target = { hidden: false };
    handler<(event: { currentTarget: typeof target }) => void>(image, "onError")({ currentTarget: target });
    expect(target.hidden).toBe(true);
  });
});

describe("выпадающий список участников (C1)", () => {
  it("участники проекта — флажками, назначенный не из проекта не теряется", () => {
    const ghost = person(9, "Бывший участник");
    expect(assigneeChoices([IVAN, ANNA], [ANNA, ghost])).toEqual([IVAN, ANNA, ghost]);
    const elements = hostElements(menu({ selectedIds: [ANNA.id] }).tree);
    const boxes = elements.filter((element) => element.type === "input" && element.props.type === "checkbox");
    expect(boxes).toHaveLength(TEAM.length);
    expect(checkboxOf(elements, ANNA)?.props.checked).toBe(true);
    expect(checkboxOf(elements, IVAN)?.props.checked).toBe(false);
    // Имя флажка — только имя участника: аватарка в строке декоративная (без подсказки, скрыта от скринридера).
    const html = unescape(renderToStaticMarkup(menu().tree));
    expect(html).not.toContain('title="Анна Смирнова"');
    expect(html).toContain('<span aria-hidden="true" class="ppm-assignee-avatar">');
  });

  it("флажок: выбор добавляет, снятие убирает, чужие id остаются", () => {
    expect(toggleAssigneeId([IVAN.id], ANNA.id)).toEqual([IVAN.id, ANNA.id]);
    expect(toggleAssigneeId([IVAN.id, ANNA.id], IVAN.id)).toEqual([ANNA.id]);
    expect(toggleAssigneeId(["ghost", IVAN.id], IVAN.id)).toEqual(["ghost"]);
  });

  it("нажатие флажка и «Снять всех» → onChange с верным набором", () => {
    const onToggle = vi.fn();
    const onClear = vi.fn();
    const elements = hostElements(menu({ onClear, onToggle, selectedIds: [IVAN.id] }).tree);
    handler<() => void>(checkboxOf(elements, ANNA), "onChange")();
    expect(onToggle).toHaveBeenCalledWith(ANNA.id);
    handler<() => void>(clearButton(elements), "onClick")();
    expect(onClear).toHaveBeenCalledTimes(1);

    const commit = vi.fn();
    const actions = assigneeSelectionActions([IVAN.id], commit, false);
    actions.toggle(ANNA.id);
    actions.toggle(IVAN.id);
    actions.clear();
    expect(commit.mock.calls).toEqual([[[IVAN.id, ANNA.id]], [[]], [[]]]);
  });

  it("«Снять всех» неактивна, когда никого не выбрано, но остаётся в фокусе (aria-disabled, не disabled)", () => {
    // disabled-кнопка в фокусе теряет фокус (Chrome уводит его в body) — клавиши ушли бы холсту (раунд 2).
    const empty = clearButton(hostElements(menu({ selectedIds: [] }).tree));
    expect(empty?.props["aria-disabled"]).toBe(true);
    expect(empty?.props.disabled).toBeUndefined();
    expect(clearButton(hostElements(menu({ selectedIds: [ANNA.id] }).tree))?.props["aria-disabled"]).toBeUndefined();
  });

  it("пока идёт сохранение — флажки не срабатывают, но остаются в фокусе (aria-disabled, не disabled)", () => {
    const commit = vi.fn();
    const actions = assigneeSelectionActions([IVAN.id], commit, true);
    actions.toggle(ANNA.id);
    actions.clear();
    expect(commit).not.toHaveBeenCalled();
    const elements = hostElements(menu({ busy: true }).tree);
    const box = checkboxOf(elements, ANNA);
    expect(box?.props["aria-disabled"]).toBe(true);
    expect(box?.props.disabled).toBeUndefined();
    expect(clearButton(elements)?.props["aria-disabled"]).toBe(true);
    expect(renderToStaticMarkup(menu({ busy: true }).tree)).toContain("Сохраняем…");
  });

  it("поиск — только при больше чем 8 участниках; без учёта регистра и «ё»", () => {
    expect(shouldShowAssigneeSearch(8)).toBe(false);
    expect(shouldShowAssigneeSearch(9)).toBe(true);
    expect(filterAssigneeChoices(TEAM, "  ИВА ")).toEqual([IVAN]);
    expect(filterAssigneeChoices(TEAM, "петр")).toEqual([IVAN, PETR]);
    expect(filterAssigneeChoices(TEAM, "")).toEqual(TEAM);
    const withSearch = renderToStaticMarkup(menu({ showSearch: true }).tree);
    expect(withSearch).toContain('type="search"');
    expect(withSearch).toContain('placeholder="Найти участника"');
    expect(renderToStaticMarkup(menu().tree)).not.toContain('type="search"');
    const onQuery = vi.fn();
    const search = hostElements(menu({ onQuery, showSearch: true }).tree).find((e) => e.props.type === "search");
    handler<(event: { currentTarget: { value: string } }) => void>(
      search,
      "onChange"
    )({
      currentTarget: { value: "ан" },
    });
    expect(onQuery).toHaveBeenCalledWith("ан");
  });

  it("пустой проект и пустой поиск — понятная строка вместо списка", () => {
    expect(renderToStaticMarkup(menu({ choices: [], total: 0 }).tree)).toContain("В проекте пока нет участников");
    expect(renderToStaticMarkup(menu({ choices: [], query: "zzz", showSearch: true }).tree)).toContain(
      "Никого не нашли"
    );
  });
});

describe("права (C1)", () => {
  it("без прав — только просмотр: ни кнопки, ни списка; аватарки и имена в подсказке на месте", () => {
    const html = unescape(
      renderToStaticMarkup(
        <PpmAssigneePicker assignees={[IVAN, ANNA]} canEdit={false} options={TEAM} onChange={vi.fn()} />
      )
    );
    expect(html).not.toContain("<button");
    expect(html).not.toContain("aria-haspopup");
    expect(html).toContain('title="Исполнители: Иван Петров, Анна Смирнова"');
    expect(count(html, 'class="ppm-assignee-avatar"')).toBe(2);
    expect(html).toContain("data-readonly");
  });

  it("с правами — кнопка открывает список (aria-haspopup, aria-expanded), без исполнителей — «Не назначен»", () => {
    const html = unescape(
      renderToStaticMarkup(
        <PpmAssigneePicker id="f-assignees" assignees={[]} canEdit options={TEAM} onChange={vi.fn()} />
      )
    );
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"/);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('id="f-assignees"');
    expect(html).toContain('aria-label="Исполнители: не назначен"');
    expect(html).toContain("Не назначен");
  });
});

describe("жесты холста (C2)", () => {
  it("корень списка гасит всплытие указателя, касаний, колёсика, кликов и перетаскивания — tldraw их не видит", () => {
    const events = [
      "onClick",
      "onContextMenu",
      "onDoubleClick",
      "onDragOver",
      "onDragStart",
      "onDrop",
      "onKeyUp",
      "onMouseDown",
      "onMouseUp",
      "onPointerCancel",
      "onPointerDown",
      "onPointerMove",
      "onPointerUp",
      "onTouchEnd",
      "onTouchMove",
      "onTouchStart",
      "onWheel",
    ];
    // Без Array#toSorted: lib web — ES2022.
    expect(new Set(Object.keys(PPM_ASSIGNEE_LAYER_GUARDS))).toEqual(new Set(events));
    for (const name of events) {
      const event = { stopPropagation: vi.fn() };
      PPM_ASSIGNEE_LAYER_GUARDS[name as keyof typeof PPM_ASSIGNEE_LAYER_GUARDS](event as never);
      expect(event.stopPropagation, name).toHaveBeenCalledTimes(1);
    }
    const root = hostElements(menu().tree)[0];
    for (const name of events) expect(root.props[name], name).toBe(PPM_ASSIGNEE_LAYER_GUARDS[name as never]);
  });

  it("клавиши из списка не доходят до body: hotkeys tldraw (Delete, ⌘Z, буквы инструментов) их не видят", () => {
    const listeners = new Map<string, (event: { stopPropagation: () => void }) => void>();
    const element = {
      className: "",
      setAttribute: vi.fn(),
      addEventListener: (type: string, listener: (event: { stopPropagation: () => void }) => void) =>
        listeners.set(type, listener),
    };
    const layer = createAssigneeLayer({ createElement: () => element } as unknown as Document);
    expect(layer).toBe(element);
    expect(new Set(listeners.keys())).toEqual(new Set(["keydown", "keypress", "keyup"]));
    for (const listener of listeners.values()) {
      const event = { stopPropagation: vi.fn() };
      listener(event);
      expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    }
    // Корень списка гасит и React-всплытие клавиш (карточка, инспектор с его Esc — предки по дереву React).
    const onKeyDown = vi.fn();
    const root = hostElements(menu({ onKeyDown }).tree)[0];
    expect(root.props.onKeyDown).toBe(onKeyDown);
  });

  it("кнопка на карточке не пускает клавиши к hotkeys tldraw, кроме Esc; стрелки открывают список", () => {
    // Backspace/Delete ещё и без действия по умолчанию: WebKit со старой настройкой уводит по ним «назад» (стенд).
    expect(assigneeTriggerKey("Backspace", false)).toBe("swallow");
    expect(assigneeTriggerKey("Delete", true)).toBe("swallow");
    expect(assigneeTriggerKey("KeyZ", false)).toBe("stop");
    expect(assigneeTriggerKey("Space", false)).toBe("stop");
    expect(assigneeTriggerKey("ArrowDown", false)).toBe("open");
    expect(assigneeTriggerKey("ArrowUp", false)).toBe("open");
    expect(assigneeTriggerKey("ArrowDown", true)).toBe("stop");
    expect(assigneeTriggerKey("Escape", false)).toBe("pass");
    expect(assigneeTriggerKey("Escape", true)).toBe("close");
  });

  it("клавиши списка: Esc закрывает, Tab — по кругу внутри, стрелки — по списку, Enter — флажок", () => {
    expect(assigneeMenuKey("Escape", false, "search")).toBe("close");
    expect(assigneeMenuKey("Tab", false, "search")).toBe("tab-next");
    expect(assigneeMenuKey("Tab", true, "option")).toBe("tab-prev");
    expect(assigneeMenuKey("ArrowDown", false, "search")).toBe("next");
    expect(assigneeMenuKey("ArrowUp", false, "option")).toBe("prev");
    expect(assigneeMenuKey("Home", false, "option")).toBe("first");
    expect(assigneeMenuKey("End", false, "option")).toBe("last");
    expect(assigneeMenuKey("Home", false, "search")).toBeUndefined();
    expect(assigneeMenuKey("Enter", false, "option")).toBe("toggle");
    expect(assigneeMenuKey("NumpadEnter", false, "option")).toBe("toggle");
    expect(assigneeMenuKey("Enter", false, "search")).toBeUndefined();
    expect(assigneeMenuKey("KeyA", false, "option")).toBeUndefined();
    // Backspace/Delete: в поиске — удаление текста, на флажке и кнопке — ничего (и никакого «назад» в WebKit).
    expect(assigneeMenuKey("Backspace", false, "search")).toBeUndefined();
    expect(assigneeMenuKey("Backspace", false, "option")).toBe("swallow");
    expect(assigneeMenuKey("Delete", false, "other")).toBe("swallow");
    expect(cycleAssigneeIndex(-1, 4, 1)).toBe(0);
    expect(cycleAssigneeIndex(-1, 4, -1)).toBe(3);
    expect(cycleAssigneeIndex(3, 4, 1)).toBe(0);
    expect(cycleAssigneeIndex(0, 4, -1)).toBe(3);
  });

  it("список — под кнопкой; у нижнего края — над ней; по ширине и высоте — в пределах окна (любой масштаб холста)", () => {
    const viewport = { height: 600, width: 800 };
    const size = { height: 200, width: 240 };
    expect(assigneePopoverPlacement({ bottom: 128, left: 50, right: 200, top: 100 }, size, viewport)).toEqual({
      left: 50,
      maxHeight: 460,
      side: "below",
      top: 132,
    });
    expect(assigneePopoverPlacement({ bottom: 528, left: 50, right: 200, top: 500 }, size, viewport)).toEqual({
      left: 50,
      maxHeight: 488,
      side: "above",
      top: 296,
    });
    expect(assigneePopoverPlacement({ bottom: 128, left: 700, right: 790, top: 100 }, size, viewport).left).toBe(552);
    // Кнопка на холсте при масштабе 25 % — крошечная, список всё равно обычного размера и целиком в окне.
    const tiny = assigneePopoverPlacement({ bottom: 301, left: 10, right: 14, top: 299 }, size, {
      height: 320,
      width: 800,
    });
    expect(tiny.top).toBeGreaterThanOrEqual(8);
    expect(tiny.top + Math.min(size.height, tiny.maxHeight)).toBeLessThanOrEqual(312);
  });

  it("видимая часть кнопки — пересечение с окном и с каждым обрезающим предком; пусто — список закрыть (раунд 2)", () => {
    const viewport = { height: 600, width: 800 };
    const button = { bottom: 128, left: 50, right: 200, top: 100 };
    expect(assigneeVisibleRect(button, [], viewport)).toEqual(button);
    // Ушла за край окна при панорамировании.
    expect(assigneeVisibleRect({ bottom: -2, left: 50, right: 200, top: -30 }, [], viewport)).toBeNull();
    // Колонка «Доски задач» (overflow: auto) прокручена — кнопка ниже её видимой части, хотя окно её вмещает.
    const column = { bottom: 90, left: 0, right: 400, top: 0 };
    expect(assigneeVisibleRect(button, [column], viewport)).toBeNull();
    // Частично видна — список остаётся и цепляется за видимую часть.
    expect(assigneeVisibleRect(button, [{ bottom: 120, left: 0, right: 400, top: 0 }], viewport)).toEqual({
      bottom: 120,
      left: 50,
      right: 200,
      top: 100,
    });
    // Холст tldraw обрезает фигуры под шапкой и рейкой v1 (overflow: clip) — это тоже предок.
    expect(assigneeVisibleRect(button, [{ bottom: 600, left: 210, right: 800, top: 52 }], viewport)).toBeNull();
    // Вырожденный прямоугольник (display: none) — не видна; скрытую вкладку доски (visibility: hidden) по прямоугольнику
    // не узнать — её ловит checkVisibility в компоненте (проверка на стенде).
    expect(assigneeVisibleRect({ bottom: 0, left: 0, right: 0, top: 0 }, [], viewport)).toBeNull();
  });

  it("клик вне списка и кнопки закрывает список, клик по кнопке или внутри — нет", () => {
    const inside = {};
    const popover = { contains: (node: unknown) => node === inside };
    const trigger = { contains: (node: unknown) => node === trigger };
    expect(isOutsideAssigneePicker({}, [popover, trigger])).toBe(true);
    expect(isOutsideAssigneePicker(inside, [popover, trigger])).toBe(false);
    expect(isOutsideAssigneePicker(trigger, [popover, trigger])).toBe(false);
    expect(isOutsideAssigneePicker(null, [popover, trigger])).toBe(false);
  });

  it("список — непрозрачный портал: гард клавиш workspace (data-ppm-canvas-modal), без aria-modal и role=listbox", () => {
    const html = renderToStaticMarkup(menu().tree);
    expect(html).toMatch(/^<div[^>]*role="dialog"/);
    expect(html).toContain('aria-label="Исполнители"');
    expect(html).toContain('data-ppm-canvas-modal=""');
    expect(html).not.toContain("aria-modal");
  });
});

describe("тексты и облик (C3)", () => {
  const keys = [
    "canvas.assignees_clear",
    "canvas.assignees_empty",
    "canvas.assignees_more",
    "canvas.assignees_no_matches",
    "canvas.assignees_saving",
    "canvas.assignees_search",
    "canvas.assignees_summary",
    "canvas.assignees_summary_none",
  ];

  it("ключи canvas.assignees_* есть в en и ru, по-русски — без английских слов", () => {
    for (const key of keys) {
      expect((PPM_TRANSLATIONS.en as Record<string, string>)[key], key).toBeTruthy();
      const value = (PPM_TRANSLATIONS.ru as Record<string, string>)[key];
      expect(value?.replaceAll(/\{\w+\}/g, ""), key).toMatch(/^[^A-Za-z]+$/);
    }
    expect(RU.clear).toBe("Снять всех");
    expect(RU.search).toBe("Найти участника");
    expect(RU.summary("Иван Петров")).toBe("Исполнители: Иван Петров");
    expect(RU.more("Мария Котова")).toBe("Ещё: Мария Котова");
  });

  it("«Не назначен» — как в Задачах (группа и столбец «Куратор»)", () => {
    expect(ru("canvas.unassigned")).toBe("Не назначен");
    expect(ru("canvas.unassigned")).toBe(ru("tasks.group.no_assignee"));
    expect(getPpmTranslation("en", "canvas.unassigned")).toBe("Unassigned");
  });

  it("стили: v2 — под грамматикой v2, у каждого var(--ppm-…) — запасное значение, список — fixed над холстом", () => {
    const css = readFileSync(
      new URL("../../core/components/ppm-canvas/canvas-assignee-picker.css", import.meta.url),
      "utf8"
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, name, next] of css.matchAll(/var\(\s*(--ppm-[\w-]+)\s*([,)])/g))
      expect(next, `${name} без запасного значения`).toBe(",");
    const preludes = [...css.matchAll(/(^|})\s*([^{}@]+)\{/g)].map((match) => match[2].replace(/\s+/g, " ").trim());
    for (const prelude of preludes.filter((selector) => selector.includes("ppm-live-card")))
      expect(prelude).toContain(':where(html[data-ppm-design="v2"]) [data-ppm-canvas-grammar="v2"]');
    // Только просмотр — <span> прямо в <label>: правило подписи поля v2 (label > span — только для скринридера) не
    // должно прятать аватарки (найдено на стенде).
    expect(css).toMatch(
      /\.ppm-work-item-card__assignees > \.ppm-assignee-trigger\[data-readonly\]\s*\{[^}]*position:\s*static[^}]*clip-path:\s*none/
    );
    expect(css).toMatch(/\.ppm-assignee-avatar > img\[hidden\]\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/\.ppm-assignee-layer\s*\{[^}]*position:\s*fixed/);
    expect(css).toMatch(/\.ppm-assignee-popover\s*\{[^}]*position:\s*fixed/);
  });
});

describe("подключение в карточках (C1)", () => {
  const source = (name: string) =>
    readFileSync(new URL(`../../core/components/ppm-canvas/${name}`, import.meta.url), "utf8").replace(/\s+/g, " ");
  const shape = source("shape.tsx");
  const inspector = source("canvas-inspector.tsx");

  it("живая карточка, карточка вида задач и инспектор — без <select multiple>", () => {
    for (const text of [shape, inspector]) {
      expect(text).not.toMatch(/<select multiple/);
      expect(text).not.toMatch(/<select[^>]*\bmultiple\b/);
      expect(text).not.toContain("selectedOptions");
    }
  });

  it("изменение уходит тем же путём, что и раньше: onUpdate / onPatch / update с { assignee_ids }", () => {
    expect(shape).toContain(
      "onChange={(assignee_ids) => projectionContext.onUpdate(shape.id, binding, { assignee_ids })}"
    );
    expect(shape).toContain("onChange={(assignee_ids) => void onPatch(item, { assignee_ids })}");
    expect(inspector).toContain("onChange={(assignee_ids) => update({ assignee_ids })}");
    expect(shape.match(/<PpmAssigneePicker\b/g)).toHaveLength(2);
    // Раунд 2: карточку «Доски задач» пересоздают при переносе между колонками — фокус переходит по ключу задачи.
    expect(shape).toContain("anchorKey={workItemsViewAnchorKey(viewId, item.identity.entity_id)}");
    expect(inspector.match(/<PpmAssigneePicker\b/g)).toHaveLength(1);
  });

  it("без прав (или без версии задачи) — только просмотр; «идёт сохранение» — только busy, кнопка остаётся", () => {
    expect(shape).toContain(
      "canEdit={projectionContext.canEdit && source.capabilities.update && Boolean(source.source_version)}"
    );
    expect(shape).toContain("busy={projectionContext.pendingWorkItemIds.has(binding.entity_id)}");
    expect(shape).toContain('canEdit={canEdit && item.capabilities.update && item.display.source_status === "active"}');
    expect(inspector).toContain("canEdit={editable && Boolean(binding.source.source_version)}");
    expect(inspector).toContain("busy={pendingWorkItemIds.has(binding.entity_id)}");
  });
});
