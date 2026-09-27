// UXR (поток параллельно релизу, 2026-09-26; владелец: «в чём смысл этих штук… непонятно реализованы»): панель Холста.
// 1) «Смысл» у обычной стрелки — в панели над выделением, только у стрелки между двумя карточками и только редактору;
//    выбор типа создаёт смысловую связь (источник — карточка начала, цель — конца) и одним шагом истории убирает стрелку;
//    «Отменить» удаляет связь и возвращает стрелку; сбой — стрелка на месте.
// 2) Кнопки «Смысловые связи» на рейке нет: раздел «Смысловые связи · N» в панели «Доска» (те же строки, удаление,
//    подтверждение/отклонение, «Связать без стрелки…» раскрывает форму); палитра открывает «Доску» на этом разделе.
// 3) «Из проекта» — значок Import и подсказка со списком. 4) Подсказки у всех кнопок рейки — при наведении и фокусе.
// 5) Признак подменю — шеврон справа от значка. Облик v1 и минимальный режим — без изменений (пин).
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Editor } from "tldraw";
import { getPpmTranslation } from "@ppm/brand";
import {
  createPpmCanvasNode,
  parseSerializedPpmCanvasNode,
  serializePpmCanvasNode,
  type TPpmCanvasBinding,
  type TPpmCanvasSemanticEdge,
  type TPpmCanvasSemanticRelationType,
} from "@ppm/canvas";
import {
  ARROW_LABEL_MAX,
  ARROW_MEANING_ORDER,
  applyArrowMeaning,
  arrowLabelText,
  arrowMeaningLink,
  arrowMeaningNotice,
  readArrowMeaningTarget,
  removeArrowForMeaning,
  undoArrowMeaning,
  type TPpmArrowMeaningDeps,
  type TPpmArrowMeaningSaved,
  type TPpmArrowMeaningTarget,
} from "@/components/ppm-canvas/canvas-arrow-meaning";
import { PpmCanvasRail } from "@/components/ppm-canvas/canvas-rail";
import { PpmSemanticLinksSection } from "@/components/ppm-canvas/canvas-semantic-links";
import { PpmArrowMeaningOptions } from "@/components/ppm-canvas/canvas-style-toolbar";
import { isSameStyleSelection, readStyleSelection } from "@/components/ppm-canvas/canvas-toolkit-actions";
import { PPM_RAIL_MENUS, railKeysLabel, railKeyShortcuts } from "@/components/ppm-canvas/canvas-toolkit-model";
import { settleCanvasSave } from "@/components/ppm-canvas/canvas-vault-picker";
import { SEMANTIC_RELATION_LABELS } from "@/components/ppm-canvas/semantic-edge-style";
import type { TPpmSemanticSectionState } from "@/components/ppm-canvas/semantic-edges-layer";
import { BOARD, NOW, USER, uuid } from "./fixtures/living-map";

vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ currentLocale: "ru", t: (key: string) => key }) }));

const dir = new URL("../../core/components/ppm-canvas/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
const editorSource = read("editor.tsx");
const railSource = read("canvas-rail.tsx");
const toolbarSource = read("canvas-style-toolbar.tsx");
const sectionSource = read("canvas-semantic-links.tsx");
const toolkitCss = read("canvas-toolkit.css");
const canvasCss = read("canvas.css");
const legacyRail = read("canvas-rail-legacy.tsx");
// Formatting-proof source checks: oxfmt may wrap calls/objects and add trailing commas.
const norm = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .replace(/([([{]) /g, "$1")
    .replace(/ ([)\]}])/g, "$1")
    .replace(/,([)\]}])/g, "$1");
const has = (source: string, needle: string) => expect(norm(source), needle).toContain(norm(needle));
const ru = (key: Parameters<typeof getPpmTranslation>[1]) => getPpmTranslation("ru", key);

/** Bodies of the CSS rules whose selector list contains `selector` exactly (comments dropped, whitespace folded). */
function cssRules(source: string, selector: string): string[] {
  const flat = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
  return [...flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, prelude]) =>
      prelude
        .split(",")
        .map((item) => item.trim())
        .includes(selector)
    )
    .map((match) => match[2]);
}

function functionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

// ─────────────── A fake tldraw editor: shapes, arrow bindings, history ───────────────

type TFakeShape = {
  id: string;
  type: string;
  isLocked?: boolean;
  parentId?: string;
  props: Record<string, unknown>;
};
type TFakeBinding = {
  id: string;
  type: "arrow";
  fromId: string;
  toId: string;
  props: { terminal: "start" | "end" };
};

const card = (id: string, title = "Карточка"): TFakeShape => ({
  id,
  type: "ppm-canvas-node",
  props: { node: serializePpmCanvasNode(createPpmCanvasNode({ authorId: USER, kind: "note", now: NOW, title })) },
});
const geo = (id: string): TFakeShape => ({ id, type: "geo", props: { color: "black", geo: "rectangle" } });
const arrow = (id: string, text = ""): TFakeShape => ({
  id,
  type: "arrow",
  parentId: "page:page",
  props: { color: "black", size: "m", text, start: { x: 0, y: 0 }, end: { x: 100, y: 0 } },
});
const bind = (arrowId: string, terminal: "start" | "end", toId: string): TFakeBinding => ({
  id: `binding:${arrowId}-${terminal}`,
  type: "arrow",
  fromId: arrowId,
  toId,
  props: { terminal },
});

const idOf = (shape: string | { id: string }) => (typeof shape === "string" ? shape : shape.id);

function fakeEditor(
  shapes: TFakeShape[],
  bindings: TFakeBinding[],
  { readonly = false, selected = [] as string[] } = {}
) {
  const store = new Map(shapes.map((shape) => [shape.id, shape]));
  let links = [...bindings];
  const calls: [string, ...unknown[]][] = [];
  const fake = {
    getShape: (shape: string | { id: string }) => store.get(idOf(shape)),
    getBindingsFromShape: (shape: string | { id: string }, type: string) =>
      links.filter((binding) => binding.fromId === idOf(shape) && binding.type === type),
    isShapeOrAncestorLocked: (shape: TFakeShape) => Boolean(shape.isLocked),
    isShapeOfType: (shape: TFakeShape, type: string) => shape.type === type,
    getIsReadonly: () => readonly,
    isIn: (path: string) => path === "select",
    isInAny: () => false,
    getSelectedShapes: () => selected.map((id) => store.get(id)).filter(Boolean),
    getShapeStyleIfExists: (shape: TFakeShape, style: { id: string }) =>
      style.id === "tldraw:color" ? (shape.props.color as string | undefined) : undefined,
    getSharedStyles: () => ({ get: () => undefined }),
    markHistoryStoppingPoint: (name: string) => calls.push(["mark", name]),
    deleteShapes: (ids: string[]) => {
      calls.push(["deleteShapes", ids]);
      for (const id of ids) store.delete(id);
      links = links.filter((binding) => !ids.includes(binding.fromId) && !ids.includes(binding.toId));
    },
    createShape: (shape: TFakeShape) => {
      calls.push(["createShape", shape.id]);
      store.set(shape.id, shape);
    },
    createBindings: (list: TFakeBinding[]) => {
      calls.push(["createBindings", list.map((binding) => binding.id)]);
      links.push(...list);
    },
    run: (fn: () => void) => fn(),
    select: (...ids: string[]) => calls.push(["select", ...ids]),
  };
  return { editor: fake as unknown as Editor, calls, store, links: () => links };
}

/** A board with two cards joined by an arrow «да»; the arrow is the only selection. */
function arrowBetweenCards(text = " да ") {
  return fakeEditor(
    [card("shape:a", "Порог ΔE"), card("shape:b", "Замер"), geo("shape:g"), arrow("shape:arrow", text)],
    [bind("shape:arrow", "start", "shape:a"), bind("shape:arrow", "end", "shape:b")],
    { selected: ["shape:arrow"] }
  );
}

const edge = (
  n: number,
  from: string,
  to: string,
  relation: TPpmCanvasSemanticRelationType,
  status: TPpmCanvasSemanticEdge["confirmation_status"] = "confirmed",
  label: string | null = null
): TPpmCanvasSemanticEdge => ({
  edge_id: uuid(8000 + n),
  board_id: BOARD,
  from_shape_id: from,
  to_shape_id: to,
  relation_type: relation,
  label,
  confidence: null,
  origin: status === "proposed" ? "agent" : "user",
  confirmation_status: status,
  confirmed_by: null,
  confirmed_at: null,
  created_by: USER,
  created_at: NOW,
  updated_at: NOW,
});

const target = { arrowId: "shape:arrow", fromShapeId: "shape:a", toShapeId: "shape:b" } as TPpmArrowMeaningTarget;

/** The editor's handler deps: an editor who stays one, a board that is saved at once (I1 below waits for real). */
function deps(patch: Partial<TPpmArrowMeaningDeps> = {}): TPpmArrowMeaningDeps {
  return {
    canEdit: () => true,
    create: async () => edge(1, "shape:a", "shape:b", "blocks"),
    remove: async () => undefined,
    settleSave: async () => true,
    ...patch,
  };
}

// ─────────────── 1. «Смысл» у обычной стрелки ───────────────

describe("UXR 1: an ordinary arrow gets a meaning", () => {
  it("offers a meaning only for an arrow bound at both ends to two different PPM cards (the form's rule)", () => {
    const { editor, store } = arrowBetweenCards();
    expect(readArrowMeaningTarget(editor, store.get("shape:arrow") as never)).toEqual(target);
    // The direction follows the arrow: start → source, end → target.
    const reversed = fakeEditor(
      [card("shape:a"), card("shape:b"), arrow("shape:arrow")],
      [bind("shape:arrow", "start", "shape:b"), bind("shape:arrow", "end", "shape:a")]
    );
    expect(readArrowMeaningTarget(reversed.editor, reversed.store.get("shape:arrow") as never)).toEqual({
      arrowId: "shape:arrow",
      fromShapeId: "shape:b",
      toShapeId: "shape:a",
    });
    const cases: [string, TFakeBinding[]][] = [
      ["one free end", [bind("shape:arrow", "start", "shape:a")]],
      ["a shape, not a card", [bind("shape:arrow", "start", "shape:a"), bind("shape:arrow", "end", "shape:g")]],
      ["the same card twice", [bind("shape:arrow", "start", "shape:a"), bind("shape:arrow", "end", "shape:a")]],
      ["a card that is gone", [bind("shape:arrow", "start", "shape:a"), bind("shape:arrow", "end", "shape:x")]],
    ];
    for (const [name, bindings] of cases) {
      const board = fakeEditor([card("shape:a"), geo("shape:g"), arrow("shape:arrow")], bindings);
      expect(readArrowMeaningTarget(board.editor, board.store.get("shape:arrow") as never), name).toBeUndefined();
    }
    expect(readArrowMeaningTarget(editorOf(), card("shape:a") as never)).toBeUndefined();
  });

  it("puts the meaning into the style toolbar's selection — for one arrow, for an editor only", () => {
    const { editor } = arrowBetweenCards();
    const selection = readStyleSelection(editor);
    expect(selection?.meaning).toEqual(target);
    expect(isSameStyleSelection(selection, readStyleSelection(arrowBetweenCards().editor))).toBe(true);
    // Two shapes selected, a reader, a locked arrow: no meaning (and for a reader — no toolbar at all).
    const two = arrowBetweenCards();
    (two.editor as unknown as { getSelectedShapes: () => unknown[] }).getSelectedShapes = () => [
      two.store.get("shape:arrow"),
      two.store.get("shape:g"),
    ];
    expect(readStyleSelection(two.editor)?.meaning).toBeUndefined();
    const reader = fakeEditor(
      [card("shape:a"), card("shape:b"), arrow("shape:arrow")],
      [bind("shape:arrow", "start", "shape:a"), bind("shape:arrow", "end", "shape:b")],
      { readonly: true, selected: ["shape:arrow"] }
    );
    expect(readStyleSelection(reader.editor)).toBeUndefined();
    const locked = arrowBetweenCards();
    (locked.store.get("shape:arrow") as TFakeShape).isLocked = true;
    expect(readStyleSelection(locked.editor)?.meaning).toBeUndefined();
    const freeArrow = fakeEditor([card("shape:a"), arrow("shape:arrow")], [bind("shape:arrow", "start", "shape:a")], {
      selected: ["shape:arrow"],
    });
    expect(readStyleSelection(freeArrow.editor)).toMatchObject({ meaning: undefined, shapeIds: ["shape:arrow"] });
    expect(
      isSameStyleSelection(readStyleSelection(freeArrow.editor), readStyleSelection(arrowBetweenCards().editor))
    ).toBe(false);
  });

  it("lists «Просто стрелка», then the frequent types, then the rest — every type once", () => {
    expect(ARROW_MEANING_ORDER.slice(0, 4)).toEqual(["relates_to", "depends_on", "blocks", "contradicts"]);
    expect(ARROW_MEANING_ORDER).toHaveLength(Object.keys(SEMANTIC_RELATION_LABELS).length);
    expect(new Set(ARROW_MEANING_ORDER)).toEqual(new Set(Object.keys(SEMANTIC_RELATION_LABELS)));
    const markup = renderToStaticMarkup(createElement(PpmArrowMeaningOptions, { onPick: () => undefined }));
    const labels = [...markup.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((match) =>
      match[1].replace(/<[^>]+>/g, "")
    );
    expect(labels).toEqual([
      "Просто стрелка",
      "Связано с",
      "Зависит от",
      "Блокирует",
      "Противоречит",
      "Объясняет",
      "Реализует",
      "Подтверждает",
      "Происходит из",
      "Результат",
    ]);
    // «Просто стрелка» is what the arrow is now.
    expect(markup).toMatch(/<button[^>]*aria-pressed="true"[^>]*>[\s\S]*?Просто стрелка/);
    expect(markup.match(/aria-pressed="true"/g)).toHaveLength(1);
  });

  it("creates the link through the existing path and then removes the arrow in one history step", async () => {
    const { editor, calls, store, links } = arrowBetweenCards();
    const saved = edge(1, "shape:a", "shape:b", "blocks", "confirmed", "да");
    const create = vi.fn(async () => {
      // Nothing touches the board before the server answers.
      expect(calls).toEqual([]);
      return saved;
    });
    const result = await applyArrowMeaning(editor, target, "blocks", undefined, deps({ create }));
    // Source — the card at the arrow's start, target — at its end; the arrow's text becomes the clarification.
    expect(create).toHaveBeenCalledWith("shape:a", "shape:b", "blocks", "да");
    expect(calls).toEqual([
      ["mark", "ppm arrow meaning"],
      ["deleteShapes", ["shape:arrow"]],
    ]);
    expect(store.has("shape:arrow")).toBe(false);
    expect(links()).toEqual([]);
    expect(result).toMatchObject({ status: "saved", arrowId: "shape:arrow", edge: saved, replaced: undefined });
    expect((result as TPpmArrowMeaningSaved).removed?.bindings.map((binding) => binding.props.terminal)).toEqual([
      "start",
      "end",
    ]);
  });

  it("I1: saves the new cards and the arrow first, then creates the link — «Сохраняем доску…» while it waits", async () => {
    const board = arrowBetweenCards();
    // The server takes a link only between shapes of the saved board version (CANVAS_EDGE_SHAPE_NOT_FOUND); the two
    // cards and the arrow were just made — nothing of them is saved yet.
    let savedShapes = new Set<string>();
    let dirty = true;
    const flush = vi.fn(async () => {
      savedShapes = new Set(board.store.keys());
      dirty = false;
    });
    const onWait = vi.fn();
    const create = vi.fn(async (from: string, to: string, relation: TPpmCanvasSemanticRelationType) => {
      if (!savedShapes.has(from) || !savedShapes.has(to)) throw new Error("CANVAS_EDGE_SHAPE_NOT_FOUND");
      return edge(3, from, to, relation);
    });
    // Without the wait the first try of a new diagram fails (review I1).
    await expect(create("shape:a", "shape:b", "blocks")).rejects.toThrow("CANVAS_EDGE_SHAPE_NOT_FOUND");
    create.mockClear();
    const settleSave = () =>
      settleCanvasSave({ flush, hasUnsaved: () => dirty, isSaving: () => false, onWait, sleep: async () => undefined });
    const result = await applyArrowMeaning(board.editor, target, "blocks", undefined, deps({ create, settleSave }));
    expect(onWait).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]);
    expect(result).toMatchObject({ status: "saved", edge: { relation_type: "blocks" } });
    expect(board.store.has("shape:arrow")).toBe(false);
    expect(ru("canvas.uxr.meaning_saving")).toBe("Сохраняем доску…");
  });

  it("I1: keeps the arrow and says the board could not be saved when the save does not settle", async () => {
    const board = arrowBetweenCards();
    const create = vi.fn(async () => edge(1, "shape:a", "shape:b", "blocks"));
    const settleSave = () =>
      settleCanvasSave({
        flush: async () => undefined,
        hasUnsaved: () => true,
        isSaving: () => false,
        sleep: async () => undefined,
      });
    const result = await applyArrowMeaning(board.editor, target, "blocks", undefined, deps({ create, settleSave }));
    expect(result).toEqual({ status: "unsaved" });
    expect(create).not.toHaveBeenCalled();
    expect(board.calls).toEqual([]);
    expect(board.store.has("shape:arrow")).toBe(true);
    expect(arrowMeaningNotice(result, "Блокирует", ru)).toEqual({
      text: "Доска не сохранилась — стрелка осталась на месте. Повторите чуть позже.",
    });
  });

  it("keeps the arrow when the server refuses, or when the arrow changed while the link was being saved", async () => {
    const failing = arrowBetweenCards();
    const result = await applyArrowMeaning(
      failing.editor,
      target,
      "blocks",
      undefined,
      deps({
        create: async () => {
          throw new Error("CANVAS_EDGE_SHAPE_NOT_FOUND");
        },
      })
    );
    expect(result).toEqual({ status: "error", previousRemoved: false });
    expect(failing.calls).toEqual([]);
    expect(failing.store.has("shape:arrow")).toBe(true);
    expect(arrowMeaningNotice(result, "Блокирует", ru)?.text).toBe(
      "Не удалось сохранить смысловую связь — стрелка осталась на месте"
    );
    // Re-bound to another card during the request: the link is saved, the (now different) arrow stays.
    const moved = arrowBetweenCards();
    moved.store.set("shape:c", card("shape:c"));
    const rebound = await applyArrowMeaning(
      moved.editor,
      target,
      "depends_on",
      undefined,
      deps({
        create: async () => {
          const end = moved.links().find((binding) => binding.props.terminal === "end");
          if (end) end.toId = "shape:c";
          return edge(2, "shape:a", "shape:b", "depends_on");
        },
      })
    );
    expect(rebound).toMatchObject({ status: "saved", removed: undefined });
    expect(moved.calls).toEqual([]);
  });

  it("M2: keeps the arrow when the board became read-only while the server answered — and says so", async () => {
    const board = arrowBetweenCards();
    let editable = true;
    const create = vi.fn(async () => {
      editable = false;
      return edge(1, "shape:a", "shape:b", "blocks");
    });
    const result = await applyArrowMeaning(
      board.editor,
      target,
      "blocks",
      undefined,
      deps({ canEdit: () => editable, create })
    );
    expect(result).toMatchObject({ status: "readonly", edge: { edge_id: uuid(8001) } });
    expect(board.calls).toEqual([]);
    expect(board.store.has("shape:arrow")).toBe(true);
    expect(arrowMeaningNotice(result, ru(SEMANTIC_RELATION_LABELS.blocks), ru)).toEqual({
      text: "Смысловая связь «Блокирует» сохранена, но доска стала только для чтения — стрелка осталась на месте",
    });
    // Rights were already gone after the save: nothing is created at all.
    const before = await applyArrowMeaning(
      arrowBetweenCards().editor,
      target,
      "blocks",
      undefined,
      deps({ canEdit: () => false, create })
    );
    expect(before).toEqual({ status: "readonly" });
    expect(create).toHaveBeenCalledTimes(1);
    // A read-only board never loses the arrow (tldraw would silently ignore the delete).
    const readonlyBoard = fakeEditor(
      [card("shape:a"), card("shape:b"), arrow("shape:arrow")],
      [bind("shape:arrow", "start", "shape:a"), bind("shape:arrow", "end", "shape:b")],
      { readonly: true }
    );
    expect(removeArrowForMeaning(readonlyBoard.editor, target)).toBeUndefined();
    expect(readonlyBoard.calls).toEqual([]);
  });

  it("M3: keeps an arrow whose text is longer than a clarification may be, instead of cutting it silently", async () => {
    const board = arrowBetweenCards("я".repeat(ARROW_LABEL_MAX + 1));
    const create = vi.fn(async () => edge(1, "shape:a", "shape:b", "blocks"));
    const settleSave = vi.fn(async () => true);
    const result = await applyArrowMeaning(board.editor, target, "blocks", undefined, deps({ create, settleSave }));
    expect(result).toEqual({ status: "label_too_long" });
    expect(settleSave).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(board.store.has("shape:arrow")).toBe(true);
    expect(arrowMeaningNotice(result, "", ru)?.text).toBe(
      "Подпись стрелки длиннее 255 знаков — сократите её, чтобы задать смысл. Стрелка осталась на месте."
    );
    // Exactly the limit fits and is kept whole.
    const fits = arrowBetweenCards("я".repeat(ARROW_LABEL_MAX));
    const whole = vi.fn(async () => edge(1, "shape:a", "shape:b", "blocks"));
    expect(await applyArrowMeaning(fits.editor, target, "blocks", undefined, deps({ create: whole }))).toMatchObject({
      status: "saved",
    });
    expect(whole).toHaveBeenCalledWith("shape:a", "shape:b", "blocks", "я".repeat(ARROW_LABEL_MAX));
    // Characters as the server counts them: 255 emoji (510 UTF-16 units) still fit.
    const emoji = arrowBetweenCards("🙂".repeat(ARROW_LABEL_MAX));
    expect(await applyArrowMeaning(emoji.editor, target, "blocks", undefined, deps())).toMatchObject({
      status: "saved",
    });
  });

  it("I2: after ⌘Z the arrow shows the type of the link it became, and another type replaces that link", async () => {
    const board = arrowBetweenCards();
    const first = (await applyArrowMeaning(board.editor, target, "blocks", undefined, deps())) as TPpmArrowMeaningSaved;
    // tldraw's ⌘Z brings the arrow back; the link stays on the server; the session remembers arrow → link.
    board.store.set("shape:arrow", arrow("shape:arrow"));
    board.links().push(...(first.removed?.bindings as unknown as TFakeBinding[]));
    const memory = new Map([["shape:arrow", first.edge.edge_id]]);
    const current = arrowMeaningLink(target, [first.edge], memory);
    expect(current?.relation_type).toBe("blocks");
    // The picker shows «Блокирует» as the current meaning, not «Просто стрелка».
    const markup = renderToStaticMarkup(
      createElement(PpmArrowMeaningOptions, { current: current?.relation_type, onPick: () => undefined })
    );
    expect(markup).toMatch(/<button[^>]*aria-pressed="true"[^>]*>(?:(?!<\/button>)[\s\S])*Блокирует/);
    expect(markup).toMatch(/<button[^>]*aria-pressed="false"[^>]*>(?:(?!<\/button>)[\s\S])*Просто стрелка/);
    expect(markup.match(/aria-pressed="true"/g)).toHaveLength(1);
    // «Зависит от»: the old link goes first, then the new one is created — never two links for one arrow.
    const order: string[] = [];
    const remove = vi.fn(async (edgeId: string) => {
      order.push(`remove ${edgeId}`);
    });
    const create = vi.fn(async (from: string, to: string, relation: TPpmCanvasSemanticRelationType) => {
      order.push(`create ${relation}`);
      return edge(2, from, to, relation);
    });
    board.calls.length = 0;
    const second = await applyArrowMeaning(board.editor, target, "depends_on", current, deps({ create, remove }));
    expect(order).toEqual([`remove ${uuid(8001)}`, "create depends_on"]);
    expect(second).toMatchObject({ status: "saved", replaced: uuid(8001), edge: { relation_type: "depends_on" } });
    expect(board.calls).toEqual([
      ["mark", "ppm arrow meaning"],
      ["deleteShapes", ["shape:arrow"]],
    ]);
  });

  it("I2: the current type changes nothing; «Просто стрелка» removes the link and keeps the arrow", async () => {
    const board = arrowBetweenCards();
    const link = edge(1, "shape:a", "shape:b", "blocks");
    const remove = vi.fn(async () => undefined);
    const create = vi.fn(async () => edge(2, "shape:a", "shape:b", "depends_on"));
    expect(await applyArrowMeaning(board.editor, target, "blocks", link, deps({ create, remove }))).toEqual({
      status: "unchanged",
    });
    expect(await applyArrowMeaning(board.editor, target, undefined, undefined, deps({ create, remove }))).toEqual({
      status: "unchanged",
    });
    expect(remove).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    const cleared = await applyArrowMeaning(board.editor, target, undefined, link, deps({ create, remove }));
    expect(cleared).toEqual({ status: "cleared", edgeId: uuid(8001) });
    expect(remove).toHaveBeenCalledWith(uuid(8001));
    expect(board.store.has("shape:arrow")).toBe(true);
    expect(board.calls).toEqual([]);
    expect(arrowMeaningNotice(cleared, "", ru)?.text).toBe("Смысловая связь удалена — это снова просто стрелка");
    // The replacement failed after the old link was deleted: the notice says so, the arrow stays.
    const failed = await applyArrowMeaning(
      board.editor,
      target,
      "depends_on",
      link,
      deps({
        remove,
        create: async () => {
          throw new Error("offline");
        },
      })
    );
    expect(failed).toEqual({ status: "error", previousRemoved: true });
    expect(arrowMeaningNotice(failed, "", ru)?.text).toBe(
      "Прежняя смысловая связь удалена, а новую сохранить не удалось — стрелка осталась на месте"
    );
    expect(board.store.has("shape:arrow")).toBe(true);
  });

  it("I2: remembers the link only while it still joins the same cards the same way", () => {
    const link = edge(1, "shape:a", "shape:b", "blocks");
    const memory = new Map([["shape:arrow", link.edge_id]]);
    expect(arrowMeaningLink(target, [link], memory)).toBe(link);
    // Deleted in «Доска», reversed or re-bound, rejected, or never made from this arrow: no current meaning.
    expect(arrowMeaningLink(target, [], memory)).toBeUndefined();
    expect(
      arrowMeaningLink(target, [{ ...link, from_shape_id: "shape:b", to_shape_id: "shape:a" }], memory)
    ).toBeUndefined();
    expect(arrowMeaningLink(target, [{ ...link, confirmation_status: "rejected" }], memory)).toBeUndefined();
    expect(arrowMeaningLink(target, [link], new Map())).toBeUndefined();
  });

  it("«Отменить» removes the link and brings the arrow back with both ends bound, as one step", async () => {
    const board = arrowBetweenCards();
    const result = (await applyArrowMeaning(
      board.editor,
      target,
      "blocks",
      undefined,
      deps()
    )) as TPpmArrowMeaningSaved;
    board.calls.length = 0;
    const remove = vi.fn(async () => undefined);
    expect(await undoArrowMeaning(board.editor, result, remove)).toBe(true);
    expect(remove).toHaveBeenCalledWith(uuid(8001));
    expect(board.calls).toEqual([
      ["mark", "ppm arrow meaning undo"],
      ["createShape", "shape:arrow"],
      ["createBindings", ["binding:shape:arrow-start", "binding:shape:arrow-end"]],
      ["select", "shape:arrow"],
    ]);
    expect(readArrowMeaningTarget(board.editor, board.store.get("shape:arrow") as never)).toEqual(target);
  });

  it("does not bring the arrow back when the link could not be removed, nor twice after ⌘Z", async () => {
    const board = arrowBetweenCards();
    const result = (await applyArrowMeaning(
      board.editor,
      target,
      "blocks",
      undefined,
      deps()
    )) as TPpmArrowMeaningSaved;
    board.calls.length = 0;
    expect(
      await undoArrowMeaning(board.editor, result, async () => {
        throw new Error("offline");
      })
    ).toBe(false);
    expect(board.calls).toEqual([]);
    // tldraw's own undo already restored the arrow: the link goes, the arrow is not created a second time.
    board.store.set("shape:arrow", arrow("shape:arrow"));
    const remove = vi.fn(async () => undefined);
    expect(await undoArrowMeaning(board.editor, result, remove)).toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(board.calls).toEqual([]);
  });

  it("reads the arrow's text as one line, whole (a longer one is refused above, never cut)", () => {
    expect(arrowLabelText({ props: { text: "  да\nнет  " } })).toBe("да нет");
    expect(arrowLabelText({ props: { text: "я".repeat(300) } })).toHaveLength(300);
    expect(arrowLabelText({ props: {} })).toBe("");
  });

  it("shows «Смысл» in the style toolbar only with a handler (v2, editor) and keeps it keyboard-reachable", () => {
    has(toolbarSource, "const semanticLinks = useContext(PpmSemanticEdgesContext);");
    has(toolbarSource, "const onSetMeaning = semanticLinks.enabled ? semanticLinks.onSetArrowMeaning : undefined;");
    has(toolbarSource, "const meaningTarget = onSetMeaning ? selection.meaning : undefined;");
    has(toolbarSource, "arrowMeaningLink(meaningTarget, semanticLinks.edges, semanticLinks.arrowLinks)");
    has(toolbarSource, "{meaningTarget && (");
    has(toolbarSource, 'aria-expanded={panel === "meaning"}');
    has(toolbarSource, '{panel === "meaning" && meaningTarget && onSetMeaning && (');
    // The panel follows the row in the DOM (Tab), clicks never take focus, ↑ ↓ ← → move between the choices.
    expect(toolbarSource.indexOf('panel === "meaning" &&')).toBeGreaterThan(
      toolbarSource.indexOf('"ppm-canvas-style-toolbar__row"')
    );
    has(toolbarSource, "const LIST_PROPS = { onKeyDown: moveFocusInColumn, onPointerDown: preventDefault };");
    has(toolbarSource, "current={meaningLink?.relation_type}");
    has(toolbarSource, "setPanel(undefined);");
    has(toolbarSource, "onSetMeaning(meaningTarget, relation);");
    // The mount of the toolbar in editor.tsx stays as AF2.1 pinned it: the handler comes through the context.
    has(editorSource, "{grammarV2 && <PpmCanvasStyleToolbar canEdit={effectiveCanEdit} />}");
  });

  it("wires the editor: save first, the session memory, focus back to «Смысл», no unhandled failure", () => {
    has(editorSource, "return edge;");
    has(editorSource, "onSetArrowMeaning: grammarV2 ? setArrowMeaning : undefined,");
    has(editorSource, "arrowLinks: grammarV2 ? arrowLinks : undefined,");
    has(editorSource, "applyArrowMeaning(activeEditor, target, relation, current, {");
    has(editorSource, "canEdit: () => editableRef.current,");
    has(
      editorSource,
      'settleSave: () => settleBoardSave(() => showMeaningNotice({ text: ppmT("canvas.uxr.meaning_saving") }))'
    );
    // The same settleCanvasSave as «Git-объект»: the autosave's own flushSave, what is unsaved, what is being saved.
    const settle = editorSource.slice(
      editorSource.indexOf("const settleBoardSave = useCallback("),
      editorSource.indexOf("const semanticSection = useMemo<TPpmSemanticSectionState>(")
    );
    has(settle, "flush: () => flushSaveRef.current(),");
    has(settle, "hasUnsaved: () => dirtyRef.current || Boolean(pendingSaveRef.current),");
    has(settle, "isSaving: () => savingRef.current,");
    has(editorSource, "settleSave: settleBoardSave");
    has(editorSource, "undoArrowMeaning(activeEditor, saved, deleteSemanticEdge)");
    has(editorSource, "linkArrow(target.arrowId, madeEdge.edge_id);");
    has(editorSource, "linkArrow(saved.arrowId, undefined);");
    has(editorSource, 'ppmT("canvas.uxr.meaning_undo")');
    has(editorSource, 'data-ppm-notice="meaning"');
    const handler = editorSource.slice(
      editorSource.indexOf("const setArrowMeaning = useCallback("),
      editorSource.indexOf("const undoMeaning = useCallback(")
    );
    // Only for someone who may edit the board right now; a keyboard choice that left the arrow goes back to «Смысл».
    expect(handler).toContain("!editableRef.current");
    has(handler, 'querySelector<HTMLElement>(".ppm-canvas-style-toolbar__meaning")');
    has(handler, 'restoreFocus(outcome.status === "saved" && Boolean(outcome.removed));');
    has(handler, "} catch {");
    const undo = editorSource.slice(
      editorSource.indexOf("const undoMeaning = useCallback("),
      editorSource.indexOf("const openSemanticPanel = useCallback(")
    );
    has(undo, "} catch {");
    // One notice at a time: a newer content notice replaces it, and it replaces an older one.
    has(editorSource, "if (contentNotice) setMeaningNotice(undefined);");
    has(editorSource, "setContentNotice(undefined);");
    // The form «Связать без стрелки…» of the section waits for the same save.
    has(
      sectionSource,
      'if (!(await section.settleSave(() => setSavingBoard(true)))) return "canvas.uxr.links_unsaved";'
    );
  });

  it("has the notice strings in both languages", () => {
    expect(ru("canvas.uxr.meaning")).toBe("Смысл");
    expect(ru("canvas.uxr.meaning_plain")).toBe("Просто стрелка");
    expect(fill(ru("canvas.uxr.meaning_saved"), { relation: ru(SEMANTIC_RELATION_LABELS.blocks) })).toBe(
      "Смысловая связь «Блокирует» сохранена"
    );
    expect(ru("canvas.uxr.meaning_undo")).toBe("Отменить");
    expect(getPpmTranslation("en", "canvas.uxr.meaning_undo")).toBe("Undo");
    expect(arrowMeaningNotice({ status: "unchanged" }, "", ru)).toBeUndefined();
  });
});

// ─────────────── 2. Список связей — раздел панели «Доска» ───────────────

const cardNodes = [card("shape:a", "Порог ΔE"), card("shape:b", "Замер"), card("shape:c", "")].map((shape) => ({
  parsed: parseSerializedPpmCanvasNode(shape.props.node as string),
  shape: shape as never,
}));

function section(patch: Partial<TPpmSemanticSectionState> = {}): TPpmSemanticSectionState {
  return {
    focusRef: { current: false },
    focusTick: 0,
    formOpen: false,
    open: true,
    setFormOpen: () => undefined,
    setOpen: () => undefined,
    settleSave: async () => true,
    ...patch,
  };
}

function renderSection({
  canEdit = true,
  edges = [
    edge(1, "shape:a", "shape:b", "blocks"),
    edge(2, "shape:b", "shape:c", "depends_on", "proposed", "по данным"),
  ],
  state = section(),
}: { canEdit?: boolean; edges?: TPpmCanvasSemanticEdge[]; state?: TPpmSemanticSectionState } = {}) {
  return renderToStaticMarkup(
    createElement(PpmSemanticLinksSection, {
      bindingsByShapeId: new Map<string, TPpmCanvasBinding>(),
      canEdit,
      edges,
      nodes: cardNodes,
      onCreate: async () => undefined,
      onDelete: async () => undefined,
      onReview: async () => undefined,
      section: state,
      selectedShapeIds: [],
    })
  );
}

describe("UXR 2: the semantic links list lives in the «Доска» panel", () => {
  it("shows «Смысловые связи · N» with the same rows, delete and confirm/reject of proposals", () => {
    const markup = renderSection();
    expect(markup).toMatch(/<summary[^>]*>Смысловые связи · 2<\/summary>/);
    expect(markup).toContain("<details");
    expect(markup).toMatch(/<details[^>]*open=""/);
    for (const text of [
      "Порог ΔE",
      "Блокирует",
      "Замер",
      "Зависит от",
      "по данным",
      "Предложено — требуется подтверждение",
    ])
      expect(markup, text).toContain(text);
    // A card without a title is named by its kind, never by its tldraw id.
    expect(markup).toContain(">Заметка<");
    expect(markup).not.toContain("shape:c");
    expect(markup.match(/>Удалить</g)).toHaveLength(2);
    expect(markup.match(/>Подтвердить</g)).toHaveLength(1);
    expect(markup.match(/>Отклонить</g)).toHaveLength(1);
    // «Связать без стрелки…» at the bottom, collapsed; the form is not there yet.
    expect(markup).toMatch(/<button[^>]*aria-expanded="false"[^>]*>[\s\S]*?Связать без стрелки…/);
    expect(markup.indexOf("Связать без стрелки…")).toBeGreaterThan(markup.lastIndexOf(">Удалить<"));
    expect(markup).not.toContain("Создать связь");
  });

  it("opens the current form under «Связать без стрелки…» — the path without a mouse", () => {
    const markup = renderSection({ state: section({ formOpen: true }) });
    expect(markup).toMatch(/<button[^>]*aria-expanded="true"[^>]*>[\s\S]*?Связать без стрелки…/);
    for (const text of ["Исходный объект", "Целевой объект", "Тип связи", "Уточнение", "Создать связь"])
      expect(markup, text).toContain(text);
    expect(markup.match(/<select/g)).toHaveLength(3);
    const controls = /aria-controls="([^"]+)"/.exec(markup)?.[1];
    expect(controls).toBeTruthy();
    expect(markup).toContain(`id="${controls}"`);
  });

  it("gives a reader the list only: no actions, no form", () => {
    const markup = renderSection({ canEdit: false });
    expect(markup).toContain("Смысловые связи · 2");
    expect(markup).not.toContain(">Удалить<");
    expect(markup).not.toContain(">Подтвердить<");
    expect(markup).not.toContain("Связать без стрелки…");
  });

  it("stays collapsed until opened, and tells how to link when the list is empty", () => {
    expect(renderSection({ state: section({ open: false }) })).not.toMatch(/<details[^>]*open=""/);
    const empty = renderSection({ edges: [] });
    expect(empty).toContain("Смысловые связи · 0");
    expect(empty).toContain("Смысловых связей пока нет.");
    expect(empty).toContain(ru("canvas.uxr.links_hint"));
  });

  it("mounts the section in the «Доска» panel under v2 and routes every entry point there", () => {
    const panel = editorSource.slice(
      editorSource.indexOf('className="ppm-canvas-status ppm-canvas-board-info__panel"'),
      editorSource.indexOf(
        "</section>",
        editorSource.indexOf('className="ppm-canvas-status ppm-canvas-board-info__panel"')
      )
    );
    has(panel, "{objectsList}");
    has(panel, "{grammarV2 && semanticLinks.section && (");
    has(panel, "<PpmSemanticLinksSection");
    // Palette «Смысловые связи», the inspector's «Все связи» and a chip click all go through openSemanticPanel:
    // under v2 it opens «Доска» on the section instead of the overlay.
    const opener = editorSource.slice(
      editorSource.indexOf("const openSemanticPanel = useCallback("),
      editorSource.indexOf("const closeSemanticPanel = useCallback(")
    );
    has(opener, "if (grammarV2) {");
    has(opener, "openSemanticSection();");
    expect(opener.indexOf("openSemanticSection();")).toBeLessThan(
      opener.indexOf("semanticPanelOpenRef.current = true;")
    );
    has(editorSource, "setBoardInfoOpen(true);");
    // The separate overlay never opens under v2.
    has(editorSource, "{semanticPanelOpen && !grammarV2 && (");
    // The list reaches CanvasControls through the context: creating or deleting a link does not rebuild the overlay.
    const memo = editorSource.slice(
      editorSource.indexOf("const components = useMemo<TLComponents>("),
      editorSource.indexOf("const projectionContext = useMemo(")
    );
    expect(memo).not.toContain("semanticEdges={semanticEdges}");
    expect(memo).not.toMatch(/\n\s+semanticEdges,\n/);
    has(editorSource, "const semanticLinks = useContext(PpmSemanticEdgesContext);");
  });

  it("does not let an overlay that still shows go under the rail (v2 only)", () => {
    const rules = cssRules(
      toolkitCss,
      ':where(html[data-ppm-design="v2"]) [data-ppm-canvas-grammar="v2"] .ppm-semantic-edges'
    );
    expect(rules.join(" ")).toContain("left: calc(var(--ppm-canvas-overlay-inset, 1rem) + 3.5rem);");
  });
});

// ─────────────── 3–5. Рейка: без «Смысловых связей», значок и подсказка «Из проекта», подсказки, шеврон ───────────────

function renderRail(canEdit: boolean): string {
  return renderToStaticMarkup(
    createElement(PpmCanvasRail, {
      activeTool: "select",
      canEdit,
      designV2: true,
      editReady: canEdit,
      expanded: false,
      onDrawGeo: () => undefined,
      onRunCommand: () => undefined,
      onToggleBoards: () => undefined,
      onToggleExpanded: () => undefined,
    })
  );
}

const buttonOf = (markup: string, attribute: string) =>
  new RegExp(`<button[^>]*${attribute}[^>]*>([\\s\\S]*?)</button>`).exec(markup)?.[0] ?? "";

describe("UXR 3–5: the rail", () => {
  it("has no «Смысловые связи» button — for an editor or a reader", () => {
    for (const markup of [renderRail(true), renderRail(false)]) {
      expect(markup).not.toContain(`aria-label="${ru("canvas.semantic_edges")}"`);
      expect(markup).not.toContain("lucide-network");
    }
    expect(railSource).not.toContain("open-semantic-edges");
    expect(railSource).not.toMatch(/\bNetwork\b/);
  });

  it("draws «Из проекта» with Import and explains what is inside", () => {
    const markup = renderRail(true);
    const project = buttonOf(markup, 'data-menu="project"');
    expect(project).toContain("lucide-import");
    expect(project).not.toContain("lucide-waypoints");
    expect(ru("canvas.uxr.tip_project")).toBe(
      "Из проекта: задача, доска задач, файл, Git-объект, документ, карта спринта"
    );
    const describedBy = /aria-describedby="([^"]+)"/.exec(project)?.[1];
    expect(describedBy).toBeTruthy();
    expect(markup).toContain(`id="${describedBy}" hidden="">${ru("canvas.uxr.tip_project")}<`);
    expect(PPM_RAIL_MENUS.project.tipKey).toBe("canvas.uxr.tip_project");
  });

  it("marks every submenu with a chevron inside the button instead of the corner triangle", () => {
    const editorRail = renderRail(true);
    for (const menu of ["shapes", "docs", "project", "more"]) {
      const trigger = buttonOf(editorRail, `data-menu="${menu}"`);
      expect(trigger, menu).toContain("ppm-canvas-toolkit-rail__chevron");
      expect(trigger, menu).toContain("lucide-chevron-right");
      expect(trigger, menu).toContain('aria-haspopup="menu"');
    }
    expect(editorRail.match(/ppm-canvas-toolkit-rail__chevron/g)).toHaveLength(4);
    expect(renderRail(false).match(/ppm-canvas-toolkit-rail__chevron/g)).toHaveLength(1);
    expect(editorRail).not.toContain("ppm-canvas-toolkit-rail__corner");
    expect(toolkitCss).not.toContain("ppm-canvas-toolkit-rail__corner");
    const chevron = cssRules(
      toolkitCss,
      ':where(html[data-ppm-design="v2"]) .ppm-canvas-toolkit-rail__tool > svg.ppm-canvas-toolkit-rail__chevron'
    ).join(" ");
    for (const declaration of ["position: absolute;", "top: 50%;", "right: 0;", "transform: translateY(-50%);"])
      expect(chevron, declaration).toContain(declaration);
  });

  it("shows a real tooltip on hover and keyboard focus: the name and the real keys", () => {
    // Visible, not only aria-label: one tooltip element next to the rail (the rail itself scrolls and would clip it).
    has(railSource, "onPointerEnter={(event) => onTip(event, hint)}");
    has(railSource, "onFocus={(event) => onTip(event, hint)}");
    has(railSource, "onPointerLeave={onTipEnd}");
    has(railSource, "onBlur={onTipEnd}");
    has(railSource, 'if (event.type === "focus" && !event.currentTarget.matches(":focus-visible")) return;');
    has(railSource, '<span className="ppm-canvas-toolkit-tip" aria-hidden="true" style={{ top: tip.top }}>');
    // No native title as well: it would draw a second tooltip over ours.
    expect(railSource).not.toMatch(/\btitle=\{/);
    const tipRule = cssRules(toolkitCss, ':where(html[data-ppm-design="v2"]) .ppm-canvas-toolkit-tip').join(" ");
    for (const declaration of ["pointer-events: none;", "position: absolute;", "left: calc(100% + 0.5rem);"])
      expect(tipRule, declaration).toContain(declaration);
    // The keys: the rail's own letters on both layouts, tldraw's undo/redo for the platform.
    expect(railKeysLabel("select", false)).toBe("V / М");
    expect(railKeysLabel("draw-pen", true)).toBe("P / З");
    expect(railKeysLabel("undo", true)).toBe("⌘Z");
    expect(railKeysLabel("undo", false)).toBe("Ctrl+Z");
    expect(railKeysLabel("redo", true)).toBe("⇧⌘Z");
    expect(railKeysLabel("redo", false)).toBe("Ctrl+Shift+Z");
    expect(railKeysLabel("add-frame", true)).toBeUndefined();
    expect(railKeyShortcuts("select")).toBe("V");
    expect(railKeyShortcuts("undo")).toBe("Control+Z Meta+Z");
    expect(railKeyShortcuts("redo")).toBe("Control+Shift+Z Meta+Shift+Z");
  });

  it("describes every submenu and the connection tool (the owner could not find the diagrams)", () => {
    const markup = renderRail(true);
    for (const menu of ["shapes", "docs", "project", "more"] as const) {
      const text = ru(PPM_RAIL_MENUS[menu].tipKey);
      expect(text, menu).toMatch(new RegExp(`^${ru(PPM_RAIL_MENUS[menu].labelKey)}: `));
      expect(markup, menu).toContain(`hidden="">${text}<`);
    }
    expect(ru("canvas.uxr.tip_docs")).toContain("схема");
    expect(ru("canvas.uxr.tip_more")).toContain("смысловые связи");
    // Review M6: the editor's «Ещё» also holds «Ссылка на доску».
    expect(ru("canvas.uxr.tip_more")).toContain(ru("canvas.rail.board_link").toLowerCase());
    const connection = buttonOf(markup, `aria-label="${ru("canvas.rail.connection")}"`);
    expect(connection).toContain("aria-describedby=");
    expect(markup).toContain(`hidden="">${ru("canvas.uxr.tip_connection")}<`);
  });
});

// ─────────────── Облик v1 и минимальный режим — без изменений (пин) ───────────────

describe("UXR: v1 and the minimal mode stay as they were (pin)", () => {
  it("keeps the v1 rail and its semantic links button with the overlay panel", () => {
    expect(legacyRail).toContain('onRunCommand("semantic-edges")');
    expect(legacyRail).toContain("title={label}");
    expect(legacyRail).not.toContain("ppm-canvas-toolkit-tip");
    // The v1 overlay: the same component, header with its close button, the same form and position.
    const panel = functionSource(editorSource, "SemanticEdgesPanel");
    has(panel, 'className="ppm-semantic-edges"');
    has(panel, 'aria-label={ppmT("canvas.semantic_edges_close")}');
    has(panel, 'ppmT("canvas.semantic_edges_visual_hint")');
    expect(panel).not.toContain("canvas.uxr.");
    const overlay = cssRules(canvasCss, ".ppm-semantic-edges").join(" ");
    for (const declaration of ["top: 0.75rem;", "left: 0.75rem;", "z-index: 330;"])
      expect(overlay, declaration).toContain(declaration);
    // v1 keeps the old path after the v2 redirect.
    const opener = editorSource.slice(
      editorSource.indexOf("const openSemanticPanel = useCallback("),
      editorSource.indexOf("const closeSemanticPanel = useCallback(")
    );
    has(opener, "if (semanticPanelOpenRef.current) return;");
    has(opener, "setSemanticPanelOpen(true);");
  });

  it("switches everything new on the v2 grammar only (the minimal mode has grammarV2 = false)", () => {
    has(editorSource, "const grammarV2 = isCanvasGrammarV2(designV2, statusPlacement);");
    has(editorSource, "{grammarV2 && semanticLinks.section && (");
    has(editorSource, "{grammarV2 && meaningNotice && (");
    for (const rule of toolkitCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)) {
      const prelude = rule[1].trim();
      if (prelude.startsWith("@")) continue;
      for (const selector of prelude.split(","))
        expect(selector.trim()).toMatch(/^:where\(html\[data-ppm-design="v2"\]\)/);
    }
  });

  it("marks balanced UXR blocks in editor.tsx", () => {
    const opened = editorSource.split("── UXR:").length - 1;
    const closed = editorSource.split("── /UXR ──").length - 1;
    expect(opened).toBeGreaterThanOrEqual(4);
    expect(closed).toBe(opened);
  });
});

// Helpers used above.
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => values[name] ?? placeholder);
}

function editorOf(): Editor {
  return fakeEditor([], []).editor;
}
