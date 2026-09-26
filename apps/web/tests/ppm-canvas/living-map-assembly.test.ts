// AF2.2 M1: «Собрать карту спринта» — выбор спринта, имя новой доски, раскладка по направлениям (R7), пакетная
// привязка S1, одно изменение доски, сборка в редакторе новой доски; шапки рамки и секций; данные рамки.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Editor } from "tldraw";
import { getPpmTranslation } from "@ppm/brand";
import {
  createPpmCanvasNode,
  createPpmMapSectionNode,
  createPpmSprintFrameNode,
  createPpmWorkItemRefNode,
  duplicatePpmCanvasNode,
  getPpmCanvasMap,
  parseSerializedPpmCanvasNode,
  serializePpmCanvasNode,
  type TPpmCanvasBoard,
} from "@ppm/canvas";
import { rectsOverlap } from "@/components/ppm-canvas/canvas-placement";
import { fillCanvasTemplate } from "@/components/ppm-canvas/canvas-grammar";
import type { TWorkItemFacts } from "@/components/ppm-canvas/living-map/living-map-types";
import {
  assembleSprintMap,
  buildSprintMapBoard,
  createSeenAfterSave,
  planSprintMap,
  sprintMapSaved,
  type TSprintMapPlan,
} from "@/components/ppm-canvas/living-map/map-assembly";
import {
  hasSprintMapAssembly,
  queueSprintMapAssembly,
  takeSprintMapAssembly,
} from "@/components/ppm-canvas/living-map/map-assembly-queue";
import {
  computeLivingMapView,
  livingMapLoadKey,
  loadLivingMapData,
  summarizeMapGroups,
} from "@/components/ppm-canvas/living-map/map-data";
import { registerPpmGroupDeleteGuard } from "@/components/ppm-canvas/living-map/map-guard";
import {
  layoutSprintMap,
  MAP_FRAME_MAX_HEIGHT,
  MAP_FRAME_WIDTH,
  MAP_LAYOUT,
  MAP_SECTION_WIDTH,
  sectionsThatFit,
} from "@/components/ppm-canvas/living-map/map-layout";
import {
  activeBoardNames,
  decodeMapGroups,
  duplicateShapeSize,
  encodeMapGroups,
  firstSprintFrame,
  groupSprintTasks,
  hasFreeBoardTab,
  mapGroupRescueIds,
  mapGroupsOf,
  ppmCanvasResizeLimits,
  selectSprintCandidates,
  sprintFrameOf,
  uniqueMapBoardName,
  type TMapCycle,
  type TMapGuardShape,
  type TMapModule,
} from "@/components/ppm-canvas/living-map/map-model";
import { applyMapChange, type TMapShapeChange } from "@/components/ppm-canvas/living-map/map-shapes";
import {
  PpmCanvasMapService,
  type TPpmCanvasBatchBindingItem,
  type TPpmCanvasBatchBindingResult,
} from "@/services/ppm-canvas-map.service";
import {
  board,
  BOARD,
  counter,
  CURRENT,
  cycle,
  issue,
  MECH,
  mBlocks,
  MODULES,
  norm,
  NOW,
  PROJECT,
  seqOf,
  SOFT,
  STATES,
  USER,
  uuid,
  workItemBinding,
  WS,
} from "./fixtures/living-map";

const t = (key: Parameters<typeof getPpmTranslation>[1]) => getPpmTranslation("ru", key);
const dir = new URL("../../core/components/ppm-canvas/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
const has = (source: string, needle: string) => expect(norm(source), needle).toContain(norm(needle));

function created(item: TPpmCanvasBatchBindingItem): TPpmCanvasBatchBindingResult {
  return { binding: workItemBinding(seqOf(item.entity_id), item.shape_id), shape_id: item.shape_id, status: "created" };
}

/** Отказ Plane с HTTP-статусом — как его видит isAxiosError. */
function httpError(status: number): Error {
  return Object.assign(new Error("Request failed"), { isAxiosError: true, response: { status } });
}

function nodeOf(change: TMapShapeChange, index: number) {
  const parsed = parseSerializedPpmCanvasNode(change.create[index].props?.node ?? "");
  if (parsed.status !== "valid" && parsed.status !== "migrated") throw new Error(`node ${index}: ${parsed.status}`);
  return parsed.node;
}

describe("AF2.2 M1: раскладка карты спринта", () => {
  it("lays directions out as full-width sections with up to four cards per row, without overlap", () => {
    const layout = layoutSprintMap([4, 5]);
    expect(MAP_SECTION_WIDTH).toBe(1520);
    expect(layout.frame).toEqual({ h: 1000, w: MAP_FRAME_WIDTH });
    expect(MAP_FRAME_WIDTH).toBe(1568);
    expect(layout.sections.map(({ h, w, x, y }) => ({ h, w, x, y }))).toEqual([
      { h: 312, w: 1520, x: 24, y: 64 },
      { h: 576, w: 1520, x: 24, y: 400 },
    ]);
    expect(layout.sections[1].cells[4]).toEqual({ x: 16, y: 312 });
    const cards = layout.sections.flatMap((section) =>
      section.cells.map((cell) => ({
        h: MAP_LAYOUT.card.h,
        w: MAP_LAYOUT.card.w,
        x: section.x + cell.x,
        y: section.y + cell.y,
      }))
    );
    for (const [index, card] of cards.entries())
      for (const other of cards.slice(index + 1)) expect(rectsOverlap(card, other, 0)).toBe(false);
    for (const section of layout.sections)
      for (const cell of section.cells) {
        expect(cell.x + MAP_LAYOUT.card.w).toBeLessThanOrEqual(section.w - MAP_LAYOUT.sectionPadding);
        expect(cell.y + MAP_LAYOUT.card.h).toBeLessThanOrEqual(section.h - MAP_LAYOUT.sectionPadding);
      }
    expect(layoutSprintMap([]).frame).toEqual({ h: 336, w: MAP_FRAME_WIDTH });
  });

  it("puts a task into its first direction by name and tasks without a known direction last (R7)", () => {
    const groups = groupSprintTasks(
      [issue(9, [SOFT, MECH]), issue(20), issue(5, [MECH]), issue(7, [SOFT]), issue(3, [uuid(7999)])],
      MODULES,
      "Без направления"
    );
    expect(groups.map((group) => [group.title, group.moduleId, group.tasks.map((task) => task.sequence_id)])).toEqual([
      ["Механика", MECH, [5, 9]],
      ["Софт", SOFT, [7]],
      ["Без направления", null, [3, 20]],
    ]);
  });

  it("lets a map group be resized past the card limit, other cards keep 1600 × 1200", () => {
    const frame = serializePpmCanvasNode(
      createPpmSprintFrameNode({
        authorId: USER,
        cycleId: CURRENT.id,
        height: 2160,
        now: NOW,
        title: "Спринт 3",
        width: MAP_FRAME_WIDTH,
      })
    );
    expect(parseSerializedPpmCanvasNode(frame).status).toBe("valid");
    expect(ppmCanvasResizeLimits(frame)).toEqual({ maxHeight: 20_000, maxWidth: 20_000, minHeight: 96, minWidth: 160 });
    const note = serializePpmCanvasNode(
      createPpmCanvasNode({ authorId: USER, kind: "note", now: NOW, title: "Заметка" })
    );
    expect(ppmCanvasResizeLimits(note)).toEqual({ maxHeight: 1200, maxWidth: 1600, minHeight: 96, minWidth: 160 });
  });
});

describe("AF2.2 M1: диалог и новая доска", () => {
  it("offers the current sprint first, then upcoming ones, then those finished within 60 days", () => {
    const cycles: TMapCycle[] = [
      cycle(8003, "Спринт 2", "2026-09-02", "2026-09-15"),
      cycle(8005, "Спринт 5", "2026-10-14", "2026-10-27"),
      CURRENT,
      cycle(8004, "Спринт 4", "2026-09-30", "2026-10-13"),
      cycle(8006, "Спринт 0", "2026-07-15", "2026-07-28"),
      cycle(8007, "Спринт −1", "2026-07-01", "2026-07-14"),
      cycle(8008, "Черновик", null, null),
      cycle(8009, "Архив", "2026-09-16", "2026-09-29", { archived_at: "2026-09-20T10:00:00Z" }),
    ];
    expect(selectSprintCandidates(cycles, new Date(2026, 8, 26, 10, 0)).map((item) => [item.name, item.phase])).toEqual(
      [
        ["Спринт 3", "current"],
        ["Спринт 4", "upcoming"],
        ["Спринт 5", "upcoming"],
        ["Спринт 2", "completed"],
        ["Спринт 0", "completed"],
      ]
    );
  });

  it("names the new board after the sprint and never reuses an active board name", () => {
    const template = t("canvas.map.board_name");
    expect(uniqueMapBoardName(template, "Спринт 3", ["Карта проекта"])).toBe("Карта · Спринт 3");
    expect(uniqueMapBoardName(template, "Спринт 3", ["карта ·  спринт 3", "Карта · Спринт 3 (2)"])).toBe(
      "Карта · Спринт 3 (3)"
    );
    expect(Array.from(uniqueMapBoardName(template, "С".repeat(200), [])).length).toBe(120);
  });

  it("plans the map, creates a new board with a free name and queues the plan before opening it", async () => {
    const newBoard = board("Карта · Спринт 3 (2)");
    const createBoard = vi
      .fn<(name: string) => Promise<TPpmCanvasBoard>>()
      .mockRejectedValueOnce(Object.assign(new Error("conflict"), { code: "CANVAS_BOARD_NAME_CONFLICT" }))
      .mockResolvedValueOnce(newBoard);
    const queue = vi.fn();
    const onBoardCreated = vi.fn();
    const result = await buildSprintMapBoard(
      {
        canOpenBoard: () => true,
        createBoard,
        existingBoardNames: () => ["Карта проекта"],
        loadModules: async () => MODULES,
        loadSprintIssues: async (cycleId) => (cycleId === CURRENT.id ? [issue(5, [MECH]), issue(7, [SOFT])] : []),
        locale: "ru",
        newShapeId: counter("shape:c"),
        onBoardCreated,
        queue,
        t,
      },
      { ...CURRENT, phase: "current" }
    );
    expect(createBoard.mock.calls.map(([name]) => name)).toEqual(["Карта · Спринт 3", "Карта · Спринт 3 (2)"]);
    expect(queue).toHaveBeenCalledWith(
      BOARD,
      expect.objectContaining({ cycleId: CURRENT.id, frameTitle: "Спринт 3 · 16–29 сент." })
    );
    expect(queue.mock.invocationCallOrder[0]).toBeLessThan(onBoardCreated.mock.invocationCallOrder[0]);
    expect(onBoardCreated).toHaveBeenCalledWith(newBoard);
    expect(result).toEqual({ boardId: BOARD, boardName: "Карта · Спринт 3 (2)", status: "created", tasks: 2 });
  });

  it("creates no board for a sprint without tasks", async () => {
    const createBoard = vi.fn();
    const result = await buildSprintMapBoard(
      {
        canOpenBoard: () => true,
        createBoard,
        existingBoardNames: () => [],
        loadModules: async () => [],
        loadSprintIssues: async () => [],
        locale: "ru",
        newShapeId: counter("shape:c"),
        onBoardCreated: vi.fn(),
        queue: vi.fn(),
        t,
      },
      { ...CURRENT, phase: "current" }
    );
    expect(result).toEqual({ status: "empty" });
    expect(createBoard).not.toHaveBeenCalled();
  });

  it("hands the plan to the new board's editor exactly once", () => {
    const plan = { cycleId: CURRENT.id, frameTitle: "Спринт 3", overflow: 0, sections: [] };
    queueSprintMapAssembly(BOARD, plan);
    expect(hasSprintMapAssembly(BOARD)).toBe(true);
    expect(takeSprintMapAssembly(BOARD)).toBe(plan);
    expect(takeSprintMapAssembly(BOARD)).toBeUndefined();
    expect(hasSprintMapAssembly(BOARD)).toBe(false);
  });
});

describe("AF2.2 M1: сборка на новой доске", () => {
  it("puts at most 200 tasks on a new map (one save activates them); the rest wait in «Не на карте»", () => {
    const issues = Array.from({ length: 205 }, (_, index) => issue(index + 1, [MECH]));
    const plan = planSprintMap({
      cycle: CURRENT,
      frameTitle: "Спринт 3",
      issues,
      modules: MODULES,
      newShapeId: counter("shape:x"),
      noDirectionTitle: "Без направления",
    });
    expect(plan.sections.flatMap((section) => section.tasks)).toHaveLength(200);
    expect(plan.sections[0].tasks.at(-1)?.workItemId).toBe(uuid(200));
    expect(plan.overflow).toBe(5);
  });

  it("binds the sprint tasks in one batch, adds frame, sections and cards as one change and registers them", async () => {
    const ids = counter("shape:m");
    const plan = planSprintMap({
      cycle: CURRENT,
      frameTitle: "Спринт 3 · 16–29 сент.",
      issues: [issue(5, [MECH]), issue(9, [SOFT, MECH]), issue(7, [SOFT]), issue(20)],
      modules: MODULES,
      newShapeId: ids,
      noDirectionTitle: "Без направления",
    });
    expect(plan.sections.map((section) => [section.title, section.tasks.map((task) => task.shapeId)])).toEqual([
      ["Механика", ["shape:m1", "shape:m2"]],
      ["Софт", ["shape:m3"]],
      ["Без направления", ["shape:m4"]],
    ]);
    const bindBatch = vi.fn(async (items: readonly TPpmCanvasBatchBindingItem[]) =>
      items.map(
        (item): TPpmCanvasBatchBindingResult =>
          item.entity_id === uuid(7)
            ? {
                error: { code: "WORK_ITEM_NOT_FOUND", message: "Задача не найдена." },
                shape_id: item.shape_id,
                status: "error",
              }
            : created(item)
      )
    );
    const applied: TMapShapeChange[] = [];
    const registerBindings = vi.fn();
    const cancelBinding = vi.fn(async () => undefined);
    const result = await assembleSprintMap(
      {
        applyChange: (change) => {
          applied.push(change);
          return true;
        },
        authorId: USER,
        bindBatch,
        cancelBinding,
        newShapeId: ids,
        now: () => NOW,
        registerBindings,
      },
      plan
    );
    expect(bindBatch).toHaveBeenCalledTimes(1);
    expect(bindBatch.mock.calls[0][0]).toEqual([
      { entity_id: uuid(5), entity_type: "work_item", shape_id: "shape:m1" },
      { entity_id: uuid(9), entity_type: "work_item", shape_id: "shape:m2" },
      { entity_id: uuid(7), entity_type: "work_item", shape_id: "shape:m3" },
      { entity_id: uuid(20), entity_type: "work_item", shape_id: "shape:m4" },
    ]);
    expect(result).toEqual({ failed: 1, frameId: "shape:m5", placed: 3 });
    expect(applied).toHaveLength(1);
    const [change] = applied;
    expect(change.update).toEqual([]);
    expect(change.moves).toEqual([]);
    expect(change.create.map((shape) => [shape.id, shape.parentId ?? null, shape.x, shape.y])).toEqual([
      ["shape:m5", null, 0, 0],
      ["shape:m6", "shape:m5", 24, 64],
      ["shape:m1", "shape:m6", 16, 48],
      ["shape:m2", "shape:m6", 392, 48],
      ["shape:m7", "shape:m5", 24, 400],
      ["shape:m4", "shape:m7", 16, 48],
    ]);
    const frame = nodeOf(change, 0);
    expect(frame.kind === "group" && frame.map).toEqual({ cycle_id: CURRENT.id, role: "sprint" });
    expect(frame).toMatchObject({ title: "Спринт 3 · 16–29 сент.", visual: { height: 736, width: 1568 } });
    const mechanics = nodeOf(change, 1);
    expect(mechanics.kind === "group" && mechanics.map).toEqual({ module_id: MECH, role: "section" });
    expect(mechanics).toMatchObject({ title: "Механика", visual: { height: 312, width: 1520 } });
    const none = nodeOf(change, 4);
    expect(none.kind === "group" && none.map).toEqual({ module_id: null, role: "section" });
    expect(nodeOf(change, 2)).toMatchObject({ binding: { entity_id: uuid(5) }, kind: "work_item_ref" });
    expect(registerBindings).toHaveBeenCalledTimes(1);
    expect(registerBindings.mock.calls[0][0].map((binding: { entity_id: string }) => binding.entity_id)).toEqual([
      uuid(5),
      uuid(9),
      uuid(20),
    ]);
    expect(cancelBinding).not.toHaveBeenCalled();
  });

  it("keeps the board untouched and cancels the pending bindings when the cards cannot be added", async () => {
    const plan = planSprintMap({
      cycle: CURRENT,
      frameTitle: "Спринт 3",
      issues: [issue(5, [MECH])],
      modules: MODULES,
      newShapeId: counter("shape:f"),
      noDirectionTitle: "Без направления",
    });
    const cancelBinding = vi.fn(async () => undefined);
    const registerBindings = vi.fn();
    await expect(
      assembleSprintMap(
        {
          applyChange: () => false,
          authorId: USER,
          bindBatch: async (items) => items.map(created),
          cancelBinding,
          newShapeId: counter("shape:g"),
          now: () => NOW,
          registerBindings,
        },
        plan
      )
    ).rejects.toThrow();
    expect(cancelBinding).toHaveBeenCalledWith(uuid(50_005));
    expect(registerBindings).not.toHaveBeenCalled();
  });

  it("applies the map as one history step, all or nothing, and never on a read-only board or a locked map", () => {
    function fakeEditor(options: { locked?: string[]; readonly?: boolean; silent?: boolean } = {}) {
      const calls: string[] = [];
      const shapes = new Set<string>(["shape:frame"]);
      const editor = {
        bailToMark: (mark: string) => calls.push(`bail ${mark}`),
        createShapes: (list: { id: string }[]) => {
          calls.push("create");
          if (!options.silent) for (const shape of list) shapes.add(shape.id);
        },
        getIsReadonly: () => Boolean(options.readonly),
        getShape: (id: string) => (shapes.has(id) ? { id } : undefined),
        isShapeOrAncestorLocked: (shape: { id: string } | undefined) =>
          Boolean(shape && options.locked?.includes(shape.id)),
        markHistoryStoppingPoint: (name: string) => {
          calls.push(`mark ${name}`);
          return "mark-1";
        },
        run: (fn: () => void) => fn(),
        updateShapes: () => calls.push("update"),
      } as unknown as Editor;
      return { calls, editor };
    }
    const change: TMapShapeChange = {
      create: [
        {
          id: "shape:a" as never,
          parentId: "shape:frame" as never,
          props: { h: 10, node: "{}", w: 10 },
          type: "ppm-canvas-node",
          x: 0,
          y: 0,
        },
      ],
      moves: [],
      update: [],
    };
    const ok = fakeEditor();
    expect(applyMapChange(ok.editor, change)).toBe(true);
    expect(ok.calls).toEqual(["mark ppm living map", "create"]);
    // Редактор молча ничего не создал — шаг откатывается к метке.
    const silent = fakeEditor({ silent: true });
    expect(applyMapChange(silent.editor, change)).toBe(false);
    expect(silent.calls).toEqual(["mark ppm living map", "create", "bail mark-1"]);
    // Только чтение или закреплённая рамка: доска не трогается вовсе (tldraw молча пропустил бы правки закреплённых).
    for (const blocked of [fakeEditor({ readonly: true }), fakeEditor({ locked: ["shape:frame"] })]) {
      expect(applyMapChange(blocked.editor, change)).toBe(false);
      expect(blocked.calls).toEqual([]);
    }
  });

  it("keeps live cards on the page when any PPM group is deleted or the assembly is undone (RM15, RM-a)", () => {
    const node = (value: Parameters<typeof serializePpmCanvasNode>[0]) => serializePpmCanvasNode(value);
    const frame = node(createPpmSprintFrameNode({ authorId: USER, cycleId: CURRENT.id, now: NOW, title: "Спринт 3" }));
    const mech = node(createPpmMapSectionNode({ authorId: USER, moduleId: MECH, now: NOW, title: "Механика" }));
    const soft = node(createPpmMapSectionNode({ authorId: USER, moduleId: SOFT, now: NOW, title: "Софт" }));
    const plain = node(createPpmCanvasNode({ authorId: USER, kind: "group", now: NOW, title: "Секция" }));
    const plainFrame = node(createPpmCanvasNode({ authorId: USER, kind: "frame", now: NOW, title: "Рамка" }));
    const note = node(createPpmCanvasNode({ authorId: USER, kind: "note", now: NOW, title: "Заметка" }));
    const card = (seq: number) =>
      node(
        createPpmWorkItemRefNode({
          authorId: USER,
          binding: {
            binding_id: uuid(50_000 + seq),
            entity_id: uuid(seq),
            entity_type: "work_item",
            source_version: "1",
          },
          now: NOW,
        })
      );
    const tree: Record<string, TMapGuardShape[]> = {
      "shape:frame": [
        { id: "shape:mech", node: mech, parentId: "shape:frame" },
        { id: "shape:soft", node: soft, parentId: "shape:frame" },
      ],
      "shape:mech": [
        { id: "shape:c5", node: card(5), parentId: "shape:mech" },
        { id: "shape:n1", node: note, parentId: "shape:mech" },
        { id: "shape:sticker", node: null, parentId: "shape:mech" },
      ],
      "shape:plain": [
        { id: "shape:c7", node: card(7), parentId: "shape:plain" },
        { id: "shape:n2", node: note, parentId: "shape:plain" },
      ],
      "shape:plainframe": [{ id: "shape:c11", node: card(11), parentId: "shape:plainframe" }],
      "shape:soft": [{ id: "shape:c9", node: card(9), parentId: "shape:soft" }],
    };
    const childrenOf = (id: string) => tree[id] ?? [];
    // Удаляется рамка (или «Отменить» сборку): живые карточки всех её секций — на страницу; заметки уходят с группой.
    expect(mapGroupRescueIds(frame, "shape:frame", childrenOf)).toEqual(["shape:c5", "shape:c9"]);
    expect(mapGroupRescueIds(mech, "shape:mech", childrenOf)).toEqual(["shape:c5"]);
    // RM-a (решение контроллера): обычные секция и рамка PPM — так же (баг AF2.1: живые карточки оставались без
    // родителя, невидимыми); карточка и заметка сами по себе — не группы.
    expect(mapGroupRescueIds(plain, "shape:plain", childrenOf)).toEqual(["shape:c7"]);
    expect(mapGroupRescueIds(plainFrame, "shape:plainframe", childrenOf)).toEqual(["shape:c11"]);
    expect(mapGroupRescueIds(card(5), "shape:c5", childrenOf)).toEqual([]);
    expect(mapGroupRescueIds(note, "shape:n1", childrenOf)).toEqual([]);
    // Ревью M1, раунд 1: страж — в своём модуле (регистрирует блок M редактора в любом облике), не в диалоге.
    const guard = read("living-map/map-guard.ts");
    has(guard, 'editor.sideEffects.registerBeforeDeleteHandler("shape", (shape, source) => {');
    has(guard, 'if (source !== "user" || shape.type !== "ppm-canvas-node") return;');
    has(guard, "if (rescue.length > 0) editor.reparentShapes(rescue as TLShapeId[], page);");
  });

  it("marks the new map as seen only after the save that activated its cards (RM14)", () => {
    const markSeen = vi.fn(async () => ({ seen_at: NOW, seen_version: 2 }));
    const seen = createSeenAfterSave(markSeen);
    const placed = [workItemBinding(5, "shape:c5"), workItemBinding(9, "shape:c9")];
    const cards = placed.map((binding) => ({ bindingId: binding.binding_id, shapeId: binding.shape_id }));
    const onBoard = (status: "active" | "pending") =>
      new Map(placed.map((binding) => [binding.shape_id, { ...binding, binding_status: status }]));
    // Пока сборка не положила карточки, ждать нечего.
    expect(seen.check(onBoard("active"))).toBe(false);
    seen.expect(placed);
    // Карточки на доске, сохранения ещё не было — или оно не прошло (409 отменяет привязки: active они не станут).
    expect(seen.check(onBoard("pending"))).toBe(false);
    const half = onBoard("pending");
    half.set("shape:c5", { ...placed[0], binding_status: "active" });
    expect(sprintMapSaved(cards, half)).toBe(false);
    expect(seen.check(half)).toBe(false);
    expect(markSeen).not.toHaveBeenCalled();
    // Сохранение прошло — одна отметка; следующие изменения привязок доски её не повторяют.
    expect(seen.check(onBoard("active"))).toBe(true);
    expect(seen.check(onBoard("active"))).toBe(false);
    expect(markSeen).toHaveBeenCalledTimes(1);
    // Карточку убрали до сохранения — её не ждём; убрали все — отметки нет.
    expect(sprintMapSaved(cards, new Map([["shape:c9", { ...placed[1], binding_status: "active" as const }]]))).toBe(
      true
    );
    expect(sprintMapSaved(cards, new Map())).toBe(false);
    // Ошибка отметки молча пропускается (без необработанного отказа): карта уже собрана.
    const failing = vi.fn(async () => {
      throw new Error("Request failed with status code 500");
    });
    const quiet = createSeenAfterSave(failing);
    quiet.expect(placed);
    expect(quiet.check(onBoard("active"))).toBe(true);
    expect(failing).toHaveBeenCalledTimes(1);
    // Сборка кладёт карточки через обёртку: сначала registerBindings F, затем ожидание сохранения; проверка — после
    // каждого изменения привязок доски; отметка — сервисом линии C.
    const dialog = read("living-map/map-assembly-dialog.tsx");
    const register = dialog.indexOf("current.registerBindings(bindings);");
    expect(register).toBeGreaterThan(-1);
    expect(register).toBeLessThan(dialog.indexOf("seenAfterSave.expect(bindings);"));
    has(dialog, "seenAfterSave.check(args.bindingsByShapeId);");
    has(dialog, "return services.changes.markSeen(workspaceId, projectId, boardId);");
    expect(dialog).toContain('from "@/services/ppm-canvas-changes.service"');
  });
});

describe("AF2.2 M1: данные рамки и секций", () => {
  it("sends one S1 request without operation ids and pairs the results with the items in order", async () => {
    const service = new PpmCanvasMapService();
    const items: TPpmCanvasBatchBindingItem[] = [
      { entity_id: uuid(5), entity_type: "work_item", shape_id: "shape:c5" },
      { entity_id: uuid(7), entity_type: "work_item", shape_id: "shape:c7" },
    ];
    const post = vi.spyOn(service, "post").mockResolvedValueOnce({
      data: {
        results: [
          created(items[0]),
          {
            error: { code: "BINDING_INVALID", details: {}, message: "Неверный пункт." },
            shape_id: null,
            status: "error",
          },
        ],
      },
    } as never);
    const results = await service.bindBatch(WS, PROJECT, BOARD, items);
    expect(post).toHaveBeenCalledWith(
      `/api/ppm/v1/workspaces/${WS}/projects/${PROJECT}/canvas/boards/${BOARD}/bindings/batch/`,
      {
        items,
      }
    );
    expect(results.map((result) => result.status)).toEqual(["created", "error"]);
    post.mockRejectedValueOnce(new Error("Network Error"));
    const failed = await service.bindBatch(WS, PROJECT, BOARD, items);
    expect(failed).toEqual(
      items.map((item) => ({
        error: { code: "CANVAS_BATCH_FAILED", message: "Network Error" },
        shape_id: item.shape_id,
        status: "error",
      }))
    );
    expect(await service.bindBatch(WS, PROJECT, BOARD, [])).toEqual([]);
  });

  it("finds the sprint frame and its sections on the board and counts their live cards", () => {
    const frameNode = serializePpmCanvasNode(
      createPpmSprintFrameNode({ authorId: USER, cycleId: CURRENT.id, now: NOW, title: "Спринт 3" })
    );
    const mechNode = serializePpmCanvasNode(
      createPpmMapSectionNode({ authorId: USER, moduleId: MECH, now: NOW, title: "Механика" })
    );
    const noneNode = serializePpmCanvasNode(
      createPpmMapSectionNode({ authorId: USER, moduleId: null, now: NOW, title: "Без направления" })
    );
    const groups = mapGroupsOf([
      { id: "shape:frame", node: frameNode, parentId: "page:page" },
      { id: "shape:mech", node: mechNode, parentId: "shape:frame" },
      { id: "shape:none", node: noneNode, parentId: "shape:frame" },
      { id: "shape:c5", node: null, parentId: "shape:mech" },
      { id: "shape:c9", node: null, parentId: "shape:mech" },
      { id: "shape:note", node: null, parentId: "shape:none" },
      // ⌘C/⌘V копия рамки: берётся первая по порядку отрисовки, вторая не мешает.
      { id: "shape:copy", node: frameNode, parentId: "page:page" },
    ]);
    expect(sprintFrameOf(groups)?.id).toBe("shape:frame");
    expect(decodeMapGroups(encodeMapGroups(groups))).toEqual(groups);
    // Итоговое ревью M-7 — правило C и M одно: первая рамка спринта ВЕРХНЕГО уровня в порядке страницы. Рамка,
    // вложенная в другую группу (раньше по порядку отрисовки), картой доски не считается.
    const plainGroup = serializePpmCanvasNode(createPpmCanvasNode({ authorId: USER, kind: "group", title: "Архив" }));
    const nested = mapGroupsOf([
      { id: "shape:holder", node: plainGroup, parentId: "page:page" },
      { id: "shape:nested", node: frameNode, parentId: "shape:holder" },
      { id: "shape:frame", node: frameNode, parentId: "page:page" },
    ]);
    expect(nested.map((group) => [group.id, group.parentId])).toEqual([
      ["shape:nested", "shape:holder"],
      ["shape:frame", "page:page"],
    ]);
    expect(sprintFrameOf(nested)?.id).toBe("shape:frame");
    expect(sprintFrameOf(decodeMapGroups(encodeMapGroups(nested)))?.id).toBe("shape:frame");
    expect(firstSprintFrame(nested)).toBe(sprintFrameOf(nested));
    expect(sprintFrameOf(nested.slice(0, 1))).toBeNull();
    const byId = new Map(groups.map((group) => [group.id, group]));
    expect(byId.get("shape:frame")?.descendants).toEqual([
      "shape:mech",
      "shape:none",
      "shape:c5",
      "shape:c9",
      "shape:note",
    ]);
    expect(byId.get("shape:none")?.map).toEqual({ module_id: null, role: "section" });
    const cards = [
      { binding: workItemBinding(5, "shape:c5"), shapeId: "shape:c5" },
      { binding: workItemBinding(9, "shape:c9"), shapeId: "shape:c9" },
    ];
    const facts = new Map<string, TWorkItemFacts>([
      [uuid(5), { blockedBy: [], traffic: "done", workItemId: uuid(5) }],
      [
        uuid(9),
        {
          blockedBy: [{ id: uuid(12), identifier: "ROBOT-12" }],
          traffic: "blocked",
          workItemId: uuid(9),
        },
      ],
    ]);
    const summaries = summarizeMapGroups(groups, cards, facts);
    expect(summaries.get("shape:mech")).toEqual({ blocked: 1, done: 1, overdue: 0, role: "section", total: 2 });
    expect(summaries.get("shape:frame")).toEqual({ blocked: 1, done: 1, overdue: 0, role: "sprint", total: 2 });
    expect(summaries.get("shape:none")).toEqual({ blocked: 0, done: 0, overdue: 0, role: "section", total: 0 });
  });

  it("shows the Plane sprint behind the frame and marks a sprint that is gone", async () => {
    const loaders = {
      cycle: vi.fn(async () => CURRENT),
      modules: vi.fn(async () => MODULES),
      projectIssues: vi.fn(async () => []),
      pullRequests: vi.fn(async () => []),
      sprintIssues: vi.fn(async () => []),
    };
    const data = await loadLivingMapData(loaders, { boardWorkItemIds: [], cycleId: CURRENT.id, now: 1_000 });
    expect(loaders.cycle).toHaveBeenCalledWith(CURRENT.id);
    const frameNode = serializePpmCanvasNode(
      createPpmSprintFrameNode({ authorId: USER, cycleId: CURRENT.id, now: NOW, title: "Спринт 3" })
    );
    const input = {
      cards: [],
      data,
      groups: mapGroupsOf([{ id: "shape:frame", node: frameNode, parentId: "page:page" }]),
      options: { assignees: [], priorities: [], states: STATES },
      projectId: PROJECT,
      projectIdentifier: "ROBOT",
      today: new Date(2026, 8, 26),
    };
    expect(computeLivingMapView(input).sprint).toEqual({
      cycleId: CURRENT.id,
      done: 5,
      endDate: "2026-09-29",
      missing: false,
      name: "Спринт 3",
      startDate: "2026-09-16",
      total: 9,
    });
    expect(computeLivingMapView(input).modules.get(MECH)?.name).toBe("Механика");
    expect(computeLivingMapView({ ...input, data: { ...data, cycle: null } }).sprint?.missing).toBe(true);
    expect(computeLivingMapView({ ...input, data: { ...data, cycleId: uuid(8099) } }).sprint).toBeNull();
  });

  it("reads nothing for a board without a map or live cards", async () => {
    expect(livingMapLoadKey(null, [])).toBe("");
    const cards = [{ binding: workItemBinding(5, "shape:c5"), shapeId: "shape:c5" }];
    expect(livingMapLoadKey(null, cards)).toBe(`-|${uuid(5)}@1`);
    expect(livingMapLoadKey(CURRENT.id, [])).toBe(`${CURRENT.id}|`);
    const loaders = {
      cycle: vi.fn(async () => CURRENT),
      modules: vi.fn(async () => MODULES),
      projectIssues: vi.fn(async () => []),
      pullRequests: vi.fn(async () => []),
      sprintIssues: vi.fn(async () => []),
    };
    const quiet = await loadLivingMapData(loaders, { boardWorkItemIds: [], cycleId: null, now: 2_000 });
    expect(quiet.loadedAt).toBe(2_000);
    for (const loader of Object.values(loaders)) expect(loader).not.toHaveBeenCalled();
    const hook = read("living-map/living-map-facts.ts");
    has(hook, "if (!loadKey || !isActive) return;");
    has(hook, ": EMPTY_LIVING_MAP_FACTS,");
    expect(hook).not.toContain("./living-map-context");
  });
});

describe("AF2.2 M1: швы с F и строки", () => {
  it("assembles only in the loaded, editable, active tab of the new board and only on an empty board", () => {
    const dialog = read("living-map/map-assembly-dialog.tsx");
    has(
      dialog,
      "if (!current.enabled || !current.isActive || !current.loaded || !current.canEdit || assemblingRef.current) return;"
    );
    has(dialog, "const plan = takeSprintMapAssembly(current.boardId);");
    has(dialog, "if (editor.getCurrentPageShapeIds().size > 0) {");
    has(dialog, "bindBatch: (items) => services.map.bindBatch(workspaceId, projectId, boardId, items),");
    has(dialog, "const open = args.enabled && args.isActive && args.canEdit && openedForBoard === args.boardId;");
    for (const marker of [
      'data-ppm-canvas-modal=""',
      'aria-modal="true"',
      'data-ppm-canvas-grammar="v2"',
      'event.code === "Escape"',
      "createPortal(",
    ])
      expect(dialog, marker).toContain(marker);
    // M-9 (итоговое ревью): второй параметр — где фокус при открытии (по умолчанию document.activeElement); вызов
    // CanvasControls прежний — openSprintMapDialog({ boardId }).
    expect(norm(dialog)).toMatch(
      /export function openSprintMapDialog\(request: TPpmSprintMapDialogRequest, activeElement: Element \| null = typeof document === "undefined" \? null : document\.activeElement\): void/
    );
  });

  it("renders map groups through its own card and lifts the resize limit only for them", () => {
    const shape = read("shape.tsx");
    has(
      shape,
      'if (grammarV2 && node.kind === "group" && node.map) return <LivingMapGroupCard node={node} shape={shape} />;'
    );
    expect(shape.indexOf("<LivingMapGroupCard")).toBeLessThan(
      shape.indexOf("return <NativeNodeCard editor={editor} node={node} shape={shape} />;")
    );
    has(shape, "const resized = resizeBox(shape, info, ppmCanvasResizeLimits(shape.props.node));");
    const editor = read("editor.tsx");
    const block = mBlocks(editor);
    has(block, "notify: (message: string) => setContentNotice(message),");
    has(block, "projectIdentifier: livingMapProjectIdentifier, workItemOptions })");
  });

  it("gives a copy of a map group the size of its node, clamped to a plain section (RM-e)", () => {
    // «Дублировать» карточки: копия рамки спринта или секции карты — обычная секция (F1: без map, не больше
    // 1600 × 1200); фигура копии должна быть того же размера, что её узел, а не размера исходной рамки.
    const frame = createPpmSprintFrameNode({
      authorId: USER,
      cycleId: CURRENT.id,
      height: 2160,
      now: NOW,
      title: "Спринт 3",
      width: MAP_FRAME_WIDTH,
    });
    const copy = duplicatePpmCanvasNode(frame, USER, NOW);
    expect(getPpmCanvasMap(copy)).toBeUndefined();
    expect(parseSerializedPpmCanvasNode(serializePpmCanvasNode(copy)).status).toBe("valid");
    expect(copy.visual).toMatchObject({ height: 1200, width: MAP_FRAME_WIDTH });
    // Размер фигуры (props) и узла (visual) нарочно разные — видно, откуда взят размер копии (ревью M1, раунд 1).
    expect(duplicateShapeSize(copy, { h: 2160, w: 1580 })).toEqual({ h: 1200, w: MAP_FRAME_WIDTH });
    // Обычная секция — тоже по своему узлу; прочие карточки — как было: размер исходной фигуры.
    const section = createPpmCanvasNode({ authorId: USER, kind: "group", now: NOW, title: "Секция" });
    const sectionCopy = duplicatePpmCanvasNode(section, USER, NOW);
    expect({ h: sectionCopy.visual.height, w: sectionCopy.visual.width }).not.toEqual({ h: 300, w: 500 });
    expect(duplicateShapeSize(sectionCopy, { h: 300, w: 500 })).toEqual({
      h: sectionCopy.visual.height,
      w: sectionCopy.visual.width,
    });
    const note = createPpmCanvasNode({ authorId: USER, kind: "note", now: NOW, title: "Заметка" });
    const noteCopy = duplicatePpmCanvasNode(note, USER, NOW);
    expect({ h: noteCopy.visual.height, w: noteCopy.visual.width }).not.toEqual({ h: 300, w: 400 });
    expect(duplicateShapeSize(noteCopy, { h: 300, w: 400 })).toEqual({ h: 300, w: 400 });
    const shape = read("shape.tsx");
    const start = shape.indexOf("function duplicateNode(");
    expect(start).toBeGreaterThan(-1);
    const duplicate = shape.slice(start, shape.indexOf("editor.select(id);", start));
    has(duplicate, "const size = duplicateShapeSize(duplicate, shape.props);");
    has(duplicate, "props: { h: size.h, node: serializePpmCanvasNode(duplicate), w: size.w }");
  });

  it("keeps the right column at least one pill tall under a tall banner (RM-f)", () => {
    // Ревью F2: колонка F (.ppm-living-map-aside, min-height: 0) под высоким баннером конфликта схлопывалась до нуля —
    // «Светофор», «Что изменилось» и «Доска» пропадали. Блок M (после блока F) держит её не ниже пилюли.
    const css = read("living-map/living-map.css");
    const m = css.slice(css.indexOf("/* ── M: "), css.indexOf("/* ── /M ── */"));
    const rule = /\[data-ppm-canvas-grammar="v2"\] \.ppm-living-map-aside \{([^}]*)\}/.exec(m);
    expect(rule?.[1]).toMatch(/min-height: 2rem;/);
    expect(css.indexOf("/* ── /F ── */")).toBeLessThan(css.indexOf("/* ── M: "));
  });

  it("names the map in both languages", () => {
    expect(t("canvas.map.dialog_build")).toBe("Собрать карту");
    expect(t("canvas.map.section_no_direction")).toBe("Без направления");
    expect(getPpmTranslation("en", "canvas.map.dialog_build")).toBe("Build map");
    expect(fillCanvasTemplate(t("canvas.map.sprint_done_many"), { done: 5, total: 9 })).toBe("5 из 9 задач готово");
    expect(fillCanvasTemplate(t("canvas.map.section_blocked_one"), { count: 1 })).toBe("1 заблокирована");
  });
});

describe("AF2.2 M1: исправления ревью, раунд 1", () => {
  // 60 направлений по одной задаче спринта: «Направление 01» … «Направление 60» (номер с нулём — порядок по названию).
  const directions = Array.from(
    { length: 60 },
    (_, index): TMapModule => ({
      archived_at: null,
      id: uuid(7100 + index),
      name: `Направление ${String(index + 1).padStart(2, "0")}`,
    })
  );
  const oneTaskEach = directions.map((direction, index) => issue(index + 1, [direction.id]));
  const buildDeps = {
    canOpenBoard: () => true,
    existingBoardNames: () => [],
    loadModules: async () => MODULES,
    loadSprintIssues: async () => [issue(5, [MECH])],
    locale: "ru",
    newShapeId: counter("shape:b"),
    t,
  };

  it("keeps the sprint frame within the group limit: sections that do not fit wait in «Не на карте»", async () => {
    // Рамка — узел группы F (≤ 20 000); секции столбцом: 64 + 336 · n — 59 секций по одной карточке — 19 888.
    expect(MAP_FRAME_MAX_HEIGHT).toBe(20_000);
    expect(sectionsThatFit(Array.from({ length: 60 }, () => 1))).toBe(59);
    expect(sectionsThatFit([200])).toBe(1);
    expect(sectionsThatFit([])).toBe(0);
    const plan = planSprintMap({
      cycle: CURRENT,
      frameTitle: "Спринт 3",
      issues: oneTaskEach,
      modules: directions,
      newShapeId: counter("shape:p"),
      noDirectionTitle: "Без направления",
    });
    expect(plan.sections).toHaveLength(59);
    expect(plan.sections.at(-1)?.title).toBe("Направление 59");
    expect(plan.overflow).toBe(1);
    const applied: TMapShapeChange[] = [];
    const cancelBinding = vi.fn(async () => undefined);
    const result = await assembleSprintMap(
      {
        applyChange: (change) => {
          applied.push(change);
          return true;
        },
        authorId: USER,
        bindBatch: async (items) => items.map(created),
        cancelBinding,
        newShapeId: counter("shape:q"),
        now: () => NOW,
        registerBindings: vi.fn(),
      },
      plan
    );
    // Не поместившаяся задача — в «Не на карте»: уведомление «на карте 59, не добавлено 1».
    expect(result).toMatchObject({ failed: 1, placed: 59 });
    expect(nodeOf(applied[0], 0).visual.height).toBe(19_888);
    expect(cancelBinding).not.toHaveBeenCalled();
  });

  it("cancels every binding S1 created when anything after it fails, and leaves the board untouched", async () => {
    // План в обход предела (60 секций): узел рамки выше 20 000 не проходит схему F — исключение уже после S1.
    const ids = counter("shape:z");
    const tooTall: TSprintMapPlan = {
      cycleId: CURRENT.id,
      frameTitle: "Спринт 3",
      overflow: 0,
      sections: oneTaskEach.map((item, index) => ({
        key: directions[index].id,
        moduleId: directions[index].id,
        tasks: [{ shapeId: ids(), workItemId: item.id }],
        title: directions[index].name,
      })),
    };
    const small = planSprintMap({
      cycle: CURRENT,
      frameTitle: "Спринт 3",
      issues: [issue(5, [MECH]), issue(7, [SOFT])],
      modules: MODULES,
      newShapeId: counter("shape:s"),
      noDirectionTitle: "Без направления",
    });
    // Сборка, которая падает после S1: отменены все привязки S1, доска и регистрация не тронуты.
    async function failAfterS1(plan: TSprintMapPlan, now: () => string) {
      const cancelBinding = vi.fn(async (_bindingId: string) => undefined);
      const applyChange = vi.fn(() => true);
      const registerBindings = vi.fn();
      await expect(
        assembleSprintMap(
          {
            applyChange,
            authorId: USER,
            bindBatch: async (items) => items.map(created),
            cancelBinding,
            newShapeId: counter("shape:w"),
            now,
            registerBindings,
          },
          plan
        )
      ).rejects.toThrow();
      const tasks = plan.sections.flatMap((section) => section.tasks);
      expect(cancelBinding).toHaveBeenCalledTimes(tasks.length);
      expect(new Set(cancelBinding.mock.calls.map(([bindingId]) => bindingId))).toEqual(
        new Set(tasks.map((task) => uuid(50_000 + seqOf(task.workItemId))))
      );
      expect(applyChange).not.toHaveBeenCalled();
      expect(registerBindings).not.toHaveBeenCalled();
    }
    await failAfterS1(tooTall, () => NOW);
    await failAfterS1(small, () => {
      throw new Error("clock");
    });
  });

  it("creates no board when no tab is free for it: the dialog warns and does not offer to build", async () => {
    // Решение контроллера: вкладки не закрываются сами; нет свободной (8 открыто) — ничего не создаётся.
    expect(hasFreeBoardTab(7)).toBe(true);
    expect(hasFreeBoardTab(8)).toBe(false);
    expect(hasFreeBoardTab(undefined)).toBe(true);
    const createBoard = vi.fn();
    const queue = vi.fn();
    const onBoardCreated = vi.fn();
    const result = await buildSprintMapBoard(
      { ...buildDeps, canOpenBoard: () => false, createBoard, onBoardCreated, queue },
      { ...CURRENT, phase: "current" }
    );
    expect(result).toEqual({ status: "tab_limit" });
    expect(createBoard).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    expect(onBoardCreated).not.toHaveBeenCalled();
    expect(t("canvas.map.dialog_tab_limit")).toBe("Открыто 8 досок — закройте одну вкладку, чтобы собрать карту");
    expect(getPpmTranslation("en", "canvas.map.dialog_tab_limit")).toBe(
      "8 boards are open — close a tab to build the map"
    );
    // Шов: workspace.tsx отдаёт число открытых вкладок (блок M), блок M редактора — args.canOpenBoard.
    has(mBlocks(read("workspace.tsx")), "openBoardCount={openBoardIds.length}");
    has(mBlocks(read("editor.tsx")), "canOpenBoard: () => hasFreeBoardTab(openBoardCountRef.current),");
    const dialog = read("living-map/map-assembly-dialog.tsx");
    has(dialog, 'const tabsFull = status === "tab_limit" || !deps.canOpenBoard();');
    has(dialog, "disabled={!selected || busy || tabsFull}");
  });

  it("fails the build on a network error while reading directions; 403 and 404 mean no directions", async () => {
    const createBoard = vi.fn();
    await expect(
      buildSprintMapBoard(
        {
          ...buildDeps,
          createBoard,
          loadModules: async () => {
            throw new Error("Network Error");
          },
          onBoardCreated: vi.fn(),
          queue: vi.fn(),
        },
        { ...CURRENT, phase: "current" }
      )
    ).rejects.toThrow("Network Error");
    expect(createBoard).not.toHaveBeenCalled();
    const service = new PpmCanvasMapService();
    const get = vi.spyOn(service, "get");
    get.mockRejectedValueOnce(httpError(403)).mockRejectedValueOnce(httpError(404));
    expect(await service.getModules("lab", PROJECT)).toEqual([]);
    expect(await service.getModules("lab", PROJECT)).toEqual([]);
    get.mockRejectedValueOnce(new Error("Network Error"));
    await expect(service.getModules("lab", PROJECT)).rejects.toThrow("Network Error");
    // Диалог: ошибка сборки — с «Повторить».
    const dialog = read("living-map/map-assembly-dialog.tsx");
    const failed = dialog.slice(dialog.indexOf('{status === "build_error" && ('));
    has(failed.slice(0, failed.indexOf("</p>")), '{ppmT("canvas.map.dialog_retry")}');
  });

  it("names the new board in the dialog exactly as it will be created", () => {
    const archived: TPpmCanvasBoard = {
      ...board("Карта · Спринт 3 (2)"),
      archived_at: NOW,
      board_id: uuid(9010),
      status: "archived",
    };
    const boards = [board("Карта · Спринт 3"), archived];
    expect(activeBoardNames(boards)).toEqual(["Карта · Спринт 3"]);
    expect(uniqueMapBoardName(t("canvas.map.board_name"), "Спринт 3", activeBoardNames(boards))).toBe(
      "Карта · Спринт 3 (2)"
    );
    const dialog = read("living-map/map-assembly-dialog.tsx");
    has(
      dialog,
      'boardName: (cycle) => uniqueMapBoardName(ppmT("canvas.map.board_name"), cycle.name, activeBoardNames(argsRef.current.boards)),'
    );
    has(dialog, "existingBoardNames: () => activeBoardNames(argsRef.current.boards),");
    has(dialog, "name: deps.boardName(selected)");
  });

  it("guards live cards of any PPM group in every look, for an editor only (RM-a)", () => {
    const plainNode = serializePpmCanvasNode(
      createPpmCanvasNode({ authorId: USER, kind: "group", now: NOW, title: "Секция" })
    );
    const cardNode = serializePpmCanvasNode(
      createPpmWorkItemRefNode({
        authorId: USER,
        binding: { binding_id: uuid(50_007), entity_id: uuid(7), entity_type: "work_item", source_version: "1" },
        now: NOW,
      })
    );
    const shapes: Record<string, { id: string; parentId: string; props: { node: string }; type: string }> = {
      "shape:c7": { id: "shape:c7", parentId: "shape:plain", props: { node: cardNode }, type: "ppm-canvas-node" },
      "shape:plain": { id: "shape:plain", parentId: "page:page", props: { node: plainNode }, type: "ppm-canvas-node" },
      "shape:sticker": { id: "shape:sticker", parentId: "shape:plain", props: { node: "" }, type: "note" },
    };
    const reparented: [string[], string][] = [];
    let handler: ((shape: unknown, source: "remote" | "user") => void) | undefined;
    const editor = {
      getAncestorPageId: () => "page:page",
      getCurrentPageId: () => "page:page",
      getShape: (id: string) => shapes[id],
      getSortedChildIdsForParent: (id: string) =>
        Object.values(shapes)
          .filter((shape) => shape.parentId === id)
          .map((shape) => shape.id),
      reparentShapes: (ids: string[], parentId: string) => reparented.push([ids, parentId]),
      sideEffects: {
        registerBeforeDeleteHandler: (_type: "shape", next: typeof handler) => {
          handler = next;
          return () => {
            handler = undefined;
          };
        },
      },
    } as unknown as Parameters<typeof registerPpmGroupDeleteGuard>[0];
    const dispose = registerPpmGroupDeleteGuard(editor);
    handler?.(shapes["shape:plain"], "remote");
    handler?.(shapes["shape:c7"], "user");
    expect(reparented).toEqual([]);
    // Обычная секция (облик и грамматика не важны): живая карточка — на страницу, стикер уходит с секцией.
    handler?.(shapes["shape:plain"], "user");
    expect(reparented).toEqual([[["shape:c7"], "page:page"]]);
    dispose();
    expect(handler).toBeUndefined();
    // Регистрирует блок M редактора — хуком вне поддерева grammarV2 и только при праве правки; диалог — больше нет.
    const env = read("editor.tsx").slice(
      read("editor.tsx").indexOf("// ── AF2.2 M: окружение линии M"),
      read("editor.tsx").indexOf("const livingMapArgs = useMemo<TLivingMapArgs>(")
    );
    has(env, "usePpmGroupDeleteGuard(editor, effectiveCanEdit);");
    const guard = read("living-map/map-guard.ts");
    has(guard, "if (!editor || !canEdit) return;");
    expect(guard).not.toMatch(/grammarV2|\.enabled\b/);
    expect(read("living-map/map-assembly-dialog.tsx")).not.toContain("registerBeforeDeleteHandler");
  });
});

describe("AF2.2 финальная волна (FW-W): пункты final-pass M1", () => {
  it("cancels the bindings S1 created but the map did not draw, after a successful build too", async () => {
    const plan = planSprintMap({
      cycle: CURRENT,
      frameTitle: "Спринт 3",
      issues: [issue(5, [MECH]), issue(9, [MECH]), issue(7, [SOFT])],
      modules: MODULES,
      newShapeId: counter("shape:k"),
      noDirectionTitle: "Без направления",
    });
    const cancelBinding = vi.fn(async (_bindingId: string) => undefined);
    const registerBindings = vi.fn();
    const applied: TMapShapeChange[] = [];
    // S1 создал привязку задачи 9 к чужой задаче (77): карточку карта не рисует, привязку — отменяет; 7 — отказ S1.
    const result = await assembleSprintMap(
      {
        applyChange: (change) => {
          applied.push(change);
          return true;
        },
        authorId: USER,
        bindBatch: async (items) =>
          items.map((item): TPpmCanvasBatchBindingResult => {
            if (item.entity_id === uuid(9))
              return { binding: workItemBinding(77, item.shape_id), shape_id: item.shape_id, status: "created" };
            if (item.entity_id === uuid(7))
              return {
                error: { code: "WORK_ITEM_NOT_FOUND", message: "Задача не найдена." },
                shape_id: item.shape_id,
                status: "error",
              };
            return created(item);
          }),
        cancelBinding,
        newShapeId: counter("shape:n"),
        now: () => NOW,
        registerBindings,
      },
      plan
    );
    expect(result).toMatchObject({ failed: 2, placed: 1 });
    expect(applied).toHaveLength(1);
    expect(registerBindings).toHaveBeenCalledTimes(1);
    expect(registerBindings.mock.calls[0][0].map((binding: { binding_id: string }) => binding.binding_id)).toEqual([
      uuid(50_005),
    ]);
    // Удачная сборка: отменена ровно лишняя привязка S1, нарисованная — нет.
    expect(cancelBinding.mock.calls).toEqual([[uuid(50_077)]]);
  });
});
