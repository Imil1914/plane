// G2.1 · линия C, раунд 2 ревью: состояние выбора исполнителей — чистые функции (env node, без DOM).
// 1) открытый список не сжимается (строка в фокусе не пропадает вместе с фокусом), страховка фокуса;
// 2) «кнопка видна» — с обрезающими предками и панелями холста поверх; 3) буфер обмена не доходит до tldraw;
// 4) черновик выбора: отправка, «идёт сохранение», новое значение, закрытие.
import { describe, expect, it, vi } from "vitest";
import {
  assigneeClipAncestors,
  assigneeClipboardVerdict,
  assigneeDraftReducer,
  assigneeMidline,
  createAssigneeClipboardGuard,
  createAssigneeDraft,
  findAssigneeAnchor,
  isAssigneeAnchorCovered,
  isClippingStyle,
  openAssigneeSession,
  shouldReclaimAssigneeFocus,
  syncAssigneeSession,
  type TPpmCanvasAssignee,
} from "@/components/ppm-canvas/canvas-assignee-picker";

const person = (n: number, display_name = `Участник ${n}`): TPpmCanvasAssignee => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  display_name,
  avatar_url: null,
});
const MEMBERS = Array.from({ length: 8 }, (_, index) => person(index + 1));
const GHOST = person(99, "Бывший участник");
const ids = (list: readonly TPpmCanvasAssignee[]) => list.map((assignee) => assignee.id);

// Узлы-заглушки: contains — по цепочке parent.
type TFakeNode = { id: string; parent: TFakeNode | null };
const node = (id: string, parent: TFakeNode | null = null): TFakeNode => ({ id, parent });
const zone = (root: TFakeNode) => ({
  contains: (target: unknown) => {
    for (let current = target as TFakeNode | null; current; current = current.parent) if (current === root) return true;
    return false;
  },
});

// Предки-заглушки: matches — только оболочка холста.
type TEl = { name: string; parentElement: TEl | null; matches: (selector: string) => boolean; clip: boolean };
const el = (name: string, parentElement: TEl | null, clip = false): TEl => ({
  clip,
  matches: (selector) => selector === ".ppm-canvas-shell" && name === "shell",
  name,
  parentElement,
});

describe("раунд 2 · 1: открытый список не сжимается", () => {
  it("строки на момент открытия остаются до закрытия: снятый бывший участник не пропадает вместе с фокусом", () => {
    const opened = openAssigneeSession([...MEMBERS, GHOST]);
    expect(ids(opened.choices)).toEqual(ids([...MEMBERS, GHOST]));
    // Сервер ответил: бывшего участника больше нет среди исполнителей — текущий список короче.
    const synced = syncAssigneeSession(opened, MEMBERS);
    expect(synced).toBe(opened);
    expect(ids(synced.choices)).toContain(GHOST.id);
  });

  it("поиск, раз показанный, остаётся до закрытия (9 → 8 участников)", () => {
    const opened = openAssigneeSession([...MEMBERS, GHOST]);
    expect(opened.search).toBe(true);
    expect(syncAssigneeSession(opened, MEMBERS).search).toBe(true);
    // 8 при открытии — поиска нет; пришёл девятый — поиск появился и не пропадёт, когда девятый уйдёт.
    const small = openAssigneeSession(MEMBERS);
    expect(small.search).toBe(false);
    const grown = syncAssigneeSession(small, [...MEMBERS, person(9)]);
    expect(grown.search).toBe(true);
    expect(ids(grown.choices)).toEqual(ids([...MEMBERS, person(9)]));
    const shrunk = syncAssigneeSession(grown, MEMBERS);
    expect(shrunk).toBe(grown);
    expect(shrunk.search).toBe(true);
  });

  it("новые участники — в конец, порядок строк не прыгает; имя и фото — свежие; без изменений — тот же объект", () => {
    const opened = openAssigneeSession(MEMBERS);
    const renamed = { ...MEMBERS[2], display_name: "Олег (новое имя)" };
    const reordered = [MEMBERS[3], renamed, ...MEMBERS.filter((_, index) => index !== 2 && index !== 3), person(10)];
    const synced = syncAssigneeSession(opened, reordered);
    expect(ids(synced.choices)).toEqual(ids([...MEMBERS, person(10)]));
    expect(synced.choices[2].display_name).toBe("Олег (новое имя)");
    expect(syncAssigneeSession(synced, reordered)).toBe(synced);
  });

  it("страховка: фокус ушёл в body при открытом списке — вернуть в корень; окно без фокуса или список закрыт — нет", () => {
    const body = { tag: "body" };
    const root = { isConnected: true };
    const doc = (activeElement: unknown, hasFocus = true) => ({
      activeElement: activeElement as Element | null,
      body: body as unknown as Element,
      hasFocus: () => hasFocus,
    });
    expect(shouldReclaimAssigneeFocus(doc(body), root, true)).toBe(true);
    expect(shouldReclaimAssigneeFocus(doc(null), root, true)).toBe(true);
    expect(shouldReclaimAssigneeFocus(doc({ tag: "input" }), root, true)).toBe(false);
    expect(shouldReclaimAssigneeFocus(doc(body, false), root, true)).toBe(false);
    expect(shouldReclaimAssigneeFocus(doc(body), root, false)).toBe(false);
    expect(shouldReclaimAssigneeFocus(doc(body), { isConnected: false }, true)).toBe(false);
    expect(shouldReclaimAssigneeFocus(doc(body), null, true)).toBe(false);
  });

  it("карточку пересоздали (перенос между колонками «Доски задач») — фокус кнопке той же задачи на новом месте", () => {
    const hidden = { dataset: { ppmAssigneeAnchor: "task-1" }, focus: vi.fn() };
    const other = { dataset: { ppmAssigneeAnchor: "task-2" }, focus: vi.fn() };
    const moved = { dataset: { ppmAssigneeAnchor: "task-1" }, focus: vi.fn() };
    const focused: unknown[] = [];
    hidden.focus.mockImplementation(() => undefined); // скрытая вкладка: focus() не срабатывает
    moved.focus.mockImplementation(() => focused.push(moved));
    const doc = {
      get activeElement() {
        return (focused.at(-1) ?? null) as Element | null;
      },
    };
    const board = { querySelectorAll: () => [hidden, other, moved] as unknown as NodeListOf<HTMLElement> };
    expect(findAssigneeAnchor(board, "task-1", doc)).toBe(moved);
    expect(hidden.focus).toHaveBeenCalledTimes(1);
    expect(other.focus).not.toHaveBeenCalled();
    expect(findAssigneeAnchor(board, "task-3", doc)).toBeNull();
  });
});

describe("раунд 2 · 2: кнопка видна — не только окно", () => {
  it("обрезают предки с overflow ≠ visible и с contain: paint/strict/content", () => {
    expect(isClippingStyle({ contain: "none", overflowX: "visible", overflowY: "visible" })).toBe(false);
    expect(isClippingStyle({ contain: "none", overflowX: "visible", overflowY: "auto" })).toBe(true);
    expect(isClippingStyle({ contain: "none", overflowX: "clip", overflowY: "clip" })).toBe(true);
    expect(isClippingStyle({ contain: "strict", overflowX: "visible", overflowY: "visible" })).toBe(true);
    expect(isClippingStyle({ contain: "layout style size", overflowX: "visible", overflowY: "visible" })).toBe(false);
  });

  it("предки собираются до оболочки холста включительно", () => {
    const page = el("page", null, true);
    const shell = el("shell", page, true);
    const canvas = el("tl-canvas", shell, true);
    const layer = el("tl-html-layer", canvas);
    const column = el("column", layer, true);
    const card = el("card", column);
    const trigger = el("trigger", card);
    expect(assigneeClipAncestors(trigger, (ancestor) => ancestor.clip).map((ancestor) => ancestor.name)).toEqual([
      "column",
      "tl-canvas",
      "shell",
    ]);
  });

  it("точки средней линии видимой части — по краям и в центре", () => {
    expect(assigneeMidline({ bottom: 120, left: 100, right: 200, top: 100 })).toEqual([
      [110, 110],
      [150, 110],
      [190, 110],
    ]);
  });

  it("панель холста поверх кнопки (рейка v2, инспектор) — закрыта; tldraw, сам список и чужие окна — нет", () => {
    const workspace = node("workspace");
    const rail = node("rail", workspace);
    const surface = node("tl-container", workspace);
    const shape = node("shape", surface);
    const trigger = node("trigger", shape);
    const handle = node("selection-handle", surface);
    const layer = node("assignee-layer");
    const toast = node("plane-toast");
    const zones = { layer: zone(layer), surface: zone(surface), trigger: zone(trigger), workspace: zone(workspace) };
    const covered = (...hits: (TFakeNode | null)[]) => isAssigneeAnchorCovered(hits as unknown as Node[], zones);
    expect(covered(rail, rail, rail)).toBe(true);
    // Частично под рейкой — не закрыта: кнопку видно и по ней нажимали.
    expect(covered(rail, rail, trigger)).toBe(false);
    expect(covered(trigger, trigger, trigger)).toBe(false);
    expect(covered(handle, handle, handle)).toBe(false);
    expect(covered(layer, layer, layer)).toBe(false);
    expect(covered(toast, toast, toast)).toBe(false);
    expect(covered(null, null, null)).toBe(false);
    // Кнопка инспектора: поверхности tldraw нет — любая панель холста поверх неё закрывает её.
    const inspectorTrigger = node("inspector-trigger", node("inspector", workspace));
    const panel = node("brain-panel", workspace);
    const inspectorZones = { ...zones, surface: null, trigger: zone(inspectorTrigger) };
    expect(isAssigneeAnchorCovered([panel, panel, panel] as unknown as Node[], inspectorZones)).toBe(true);
    expect(
      isAssigneeAnchorCovered(
        [inspectorTrigger, inspectorTrigger, inspectorTrigger] as unknown as Node[],
        inspectorZones
      )
    ).toBe(false);
    // Вне рабочей области холста (минимальный режим без неё) — не судим.
    expect(isAssigneeAnchorCovered([rail, rail, rail] as unknown as Node[], { ...zones, workspace: null })).toBe(false);
  });
});

describe("раунд 2 · 3: буфер обмена не доходит до холста", () => {
  const trigger = node("trigger");
  const popover = node("popover");
  const search = node("search", popover);
  const checkbox = node("checkbox", popover);
  const clear = node("clear", popover);
  const zones = { popover: zone(popover), search: search as unknown as Node, trigger: zone(trigger) };
  const verdict = (active: TFakeNode | null) => assigneeClipboardVerdict(active as unknown as Node, zones);

  it("кнопка, «Снять всех», флажок — перехват; поле поиска — обычная правка текста; вне выбора — не наше дело", () => {
    expect(verdict(trigger)).toBe("block");
    expect(verdict(clear)).toBe("block");
    expect(verdict(checkbox)).toBe("block");
    expect(verdict(popover)).toBe("block");
    expect(verdict(search)).toBe("allow");
    expect(verdict(node("canvas"))).toBe("outside");
    expect(verdict(null)).toBe("outside");
  });

  it("слушатели — в фазе захвата на document и только пока фокус в выборе; ушёл — снимаются сами", () => {
    const listeners = new Map<
      string,
      { listener: (event: { stopPropagation: () => void }) => void; capture: unknown }
    >();
    const target = {
      addEventListener: vi.fn((type: string, listener: never, capture: unknown) =>
        listeners.set(type, { capture, listener })
      ),
      removeEventListener: vi.fn((type: string) => listeners.delete(type)),
    };
    let current: "allow" | "block" | "outside" = "block";
    const guard = createAssigneeClipboardGuard(target, () => current);
    expect(listeners.size).toBe(0);
    guard.arm();
    guard.arm();
    expect(target.addEventListener).toHaveBeenCalledTimes(4);
    expect(new Set(listeners.keys())).toEqual(new Set(["copy", "cut", "focusin", "paste"]));
    for (const { capture } of listeners.values()) expect(capture).toBe(true);

    for (const type of ["copy", "cut", "paste"]) {
      const event = { stopPropagation: vi.fn() };
      listeners.get(type)?.listener(event);
      expect(event.stopPropagation, type).toHaveBeenCalledTimes(1);
    }
    current = "allow";
    const inSearch = { stopPropagation: vi.fn() };
    listeners.get("paste")?.listener(inSearch);
    expect(inSearch.stopPropagation).not.toHaveBeenCalled();
    expect(guard.isArmed()).toBe(true);

    // Фокус ушёл на холст — focusin вне выбора снимает все слушатели.
    current = "outside";
    listeners.get("focusin")?.listener({ stopPropagation: vi.fn() });
    expect(guard.isArmed()).toBe(false);
    expect(listeners.size).toBe(0);

    // Фокус пропал молча (body без focusin): событие не перехватывается, слушатели снимаются.
    current = "block";
    guard.arm();
    current = "outside";
    const onBody = { stopPropagation: vi.fn() };
    listeners.get("cut")?.listener(onBody);
    expect(onBody.stopPropagation).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);

    // Размонтирование.
    current = "block";
    guard.arm();
    guard.disarm();
    guard.disarm();
    expect(listeners.size).toBe(0);
    expect(target.removeEventListener).toHaveBeenCalledTimes(12);
  });
});

describe("раунд 2 · 4: черновик выбора", () => {
  const A = person(1).id;
  const B = person(2).id;

  it("отправка — черновик виден сразу; пока идёт сохранение — держится; ответ с новым значением — сброшен", () => {
    let draft = createAssigneeDraft(A, false);
    expect(draft.ids).toBeNull();
    draft = assigneeDraftReducer(draft, { type: "commit", ids: [A, B] });
    expect(draft.ids).toEqual([A, B]);
    draft = assigneeDraftReducer(draft, { busy: true, type: "sync", valueKey: A });
    expect(draft.ids).toEqual([A, B]);
    draft = assigneeDraftReducer(draft, { busy: false, type: "sync", valueKey: `${A},${B}` });
    expect(draft).toEqual({ busy: false, ids: null, valueKey: `${A},${B}` });
  });

  it("запрос закончился ошибкой (значение прежнее, сохранение кончилось) — черновик сброшен, видно прежнее", () => {
    let draft = assigneeDraftReducer(createAssigneeDraft(A, false), { type: "commit", ids: [] });
    draft = assigneeDraftReducer(draft, { busy: true, type: "sync", valueKey: A });
    draft = assigneeDraftReducer(draft, { busy: false, type: "sync", valueKey: A });
    expect(draft.ids).toBeNull();
  });

  it("значение сменилось без нашего запроса (правка другого пользователя) — черновик сброшен", () => {
    let draft = assigneeDraftReducer(createAssigneeDraft(A, false), { type: "commit", ids: [B] });
    draft = assigneeDraftReducer(draft, { busy: false, type: "sync", valueKey: "" });
    expect(draft.ids).toBeNull();
  });

  it("закрытие: запрос ещё идёт — черновик ждёт ответа; запроса нет — сразу к значению задачи", () => {
    const pending = assigneeDraftReducer(
      assigneeDraftReducer(createAssigneeDraft(A, false), { type: "commit", ids: [B] }),
      { busy: true, type: "sync", valueKey: A }
    );
    expect(assigneeDraftReducer(pending, { type: "close" })).toBe(pending);
    const idle = assigneeDraftReducer(createAssigneeDraft(A, false), { type: "commit", ids: [B] });
    expect(assigneeDraftReducer(idle, { type: "close" }).ids).toBeNull();
  });

  it("синхронизация без изменений возвращает тот же объект (обновление при отрисовке не зацикливается)", () => {
    const draft = assigneeDraftReducer(createAssigneeDraft(A, false), { type: "commit", ids: [B] });
    expect(assigneeDraftReducer(draft, { busy: false, type: "sync", valueKey: A })).toBe(draft);
    const clean = createAssigneeDraft(A, false);
    expect(assigneeDraftReducer(clean, { type: "close" })).toBe(clean);
  });
});
