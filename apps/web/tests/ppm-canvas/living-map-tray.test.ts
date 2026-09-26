// AF2.2 M4: «Не на карте» — задачи спринта и их PR без карточки на доске; «+ Добавить» / «Разложить всё» кладут в
// секцию своего направления, в свободную ячейку без наложений (секция растёт, всё ниже сдвигается), только по нажатию
// редактора активной вкладки; читатель видит список без кнопок. Решения контроллера: RM-b — пока лоток развёрнут,
// инспектор скрыт; RM-c — ручной PR без объекта Git виден, но не кладётся; RM-d — за нажатие не больше 200. Рамка
// спринта при росте не выше предела группы F (ревью M1): не помещается — ничего не кладём. Ревью M4, раунд 1: один PR —
// один пункт; опрос привязок не стирает несохранённые карточки; лоток открывается свёрнутым (выбор помним по доске);
// отбор нажатия — чистая selectTrayRequests; новая секция — по ширине рамки.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getPpmTranslation } from "@ppm/brand";
import {
  createPpmMapSectionNode,
  createPpmSprintFrameNode,
  parseSerializedPpmCanvasNode,
  serializePpmCanvasNode,
} from "@ppm/canvas";
import { fillCanvasTemplate } from "@/components/ppm-canvas/canvas-grammar";
import { PPM_LIVING_MAP_DEFAULT, PpmLivingMapContext } from "@/components/ppm-canvas/living-map/living-map-context";
import { EMPTY_LIVING_MAP_ARGS, type TLivingMapArgs } from "@/components/ppm-canvas/living-map/living-map-types";
import { computeLivingMapView, EMPTY_LIVING_MAP_DATA } from "@/components/ppm-canvas/living-map/map-data";
import {
  MAP_FRAME_MAX_HEIGHT,
  mapPlacementFits,
  planMapPlacement,
  type TMapState,
} from "@/components/ppm-canvas/living-map/map-layout";
import {
  mapGroupsOf,
  mapPullRequestSchema,
  mergeRefreshedBindings,
  parseMapList,
  type TLivingMapTray,
  type TMapPlacementRequest,
  type TPlaceOnMapResult,
} from "@/components/ppm-canvas/living-map/map-model";
import {
  buildPlacementChange,
  mapStateFromRecords,
  type TMapShapeChange,
} from "@/components/ppm-canvas/living-map/map-shapes";
import {
  collectNotOnMap,
  isPlaceableTrayItem,
  placementRoom,
  placeOnMap,
  readTrayExpanded,
  selectTrayRequests,
  trayPlacementNotice,
  trayPlacementRequest,
  trayStorageKey,
  writeTrayExpanded,
} from "@/components/ppm-canvas/living-map/not-on-map";
import { PpmNotOnMapTray } from "@/components/ppm-canvas/living-map/not-on-map-tray";
import type { TPpmCanvasBatchBindingItem, TPpmCanvasBatchBindingResult } from "@/services/ppm-canvas-map.service";
import {
  BOARD,
  counter,
  CURRENT,
  issue,
  MECH,
  MODULES,
  norm,
  NOW,
  PEOPLE,
  PRES,
  PROJECT,
  pullRequestBinding,
  pullRequestLink,
  seqOf,
  SOFT,
  STATE,
  STATES,
  USER,
  uuid,
  workItemBinding,
} from "./fixtures/living-map";

vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ currentLocale: "ru", t: (key: string) => key }) }));

const dir = new URL("../../core/components/ppm-canvas/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
const has = (source: string, needle: string) => expect(norm(source), needle).toContain(norm(needle));
const TASK = { h: 248, w: 360 };
const FRAME_NODE = serializePpmCanvasNode(
  createPpmSprintFrameNode({
    authorId: USER,
    cycleId: CURRENT.id,
    height: 736,
    now: NOW,
    title: "Спринт 3",
    width: 1568,
  })
);
const section = (moduleId: string | null, height: number) =>
  serializePpmCanvasNode(
    createPpmMapSectionNode({
      authorId: USER,
      height,
      moduleId,
      now: NOW,
      title: moduleId ? "Направление" : "Без направления",
      width: 1520,
    })
  );
const cell = (index: number) => ({ h: 248, w: 360, x: 16 + (index % 4) * 376, y: 48 + Math.floor(index / 4) * 264 });
const request = (key: string, moduleId: string | null, size = TASK): TMapPlacementRequest => ({
  entityId: uuid(Number(key.replace(/\D/g, "")) || 1),
  entityType: "work_item",
  key,
  moduleId,
  sectionTitle: moduleId ? "Презентация" : "Без направления",
  size,
});

function mapState(
  mechCells: number[],
  softChildren: { h: number; w: number; x: number; y: number }[] = [cell(0)]
): TMapState {
  return {
    frame: { h: 736, id: "shape:frame", node: FRAME_NODE, w: 1568 },
    others: [],
    sections: [
      {
        children: mechCells.map(cell),
        h: 312,
        id: "shape:mech",
        moduleId: MECH,
        node: section(MECH, 312),
        type: "ppm-canvas-node",
        w: 1520,
        x: 24,
        y: 64,
      },
      {
        children: softChildren,
        h: 312,
        id: "shape:soft",
        moduleId: SOFT,
        node: section(SOFT, 312),
        type: "ppm-canvas-node",
        w: 1520,
        x: 24,
        y: 400,
      },
    ],
  };
}

describe("AF2.2 M4: что лежит в лотке", () => {
  it("lists the sprint tasks without a card and the active PRs of sprint tasks without a PR card", () => {
    const items = collectNotOnMap({
      cards: [
        { binding: workItemBinding(5, "shape:c5"), shapeId: "shape:c5" },
        { binding: workItemBinding(16, "shape:c16"), shapeId: "shape:c16" },
        { binding: pullRequestBinding(46, "shape:pr46"), shapeId: "shape:pr46" },
      ],
      issues: new Map(
        [
          issue(5, [MECH]),
          issue(16, [MECH]),
          issue(20, [PRES], { assignee_ids: [uuid(5001)], state_id: STATE.backlog }),
          issue(19, [MECH, SOFT], { assignee_ids: [uuid(5001)] }),
          issue(21, []),
        ].map((item) => [item.id, item])
      ),
      modules: new Map(MODULES.map((item) => [item.id, item])),
      options: { assignees: PEOPLE, priorities: [], states: STATES },
      projectIdentifier: "ROBOT",
      pullRequests: [
        pullRequestLink(50, 16),
        pullRequestLink(46, 11),
        pullRequestLink(47, 5, { status: "unlinked" }),
        pullRequestLink(48, 5, { object_type: "branch" }),
        pullRequestLink(49, 99),
      ],
      sprintIssueIds: [uuid(5), uuid(16), uuid(20), uuid(19), uuid(21)],
    });
    expect(items.map((item) => item.key)).toEqual([
      `task:${uuid(19)}`,
      `task:${uuid(20)}`,
      `task:${uuid(21)}`,
      `pr:${uuid(30_050)}`,
    ]);
    expect(items[0]).toMatchObject({
      assignees: "Миша К.",
      identifier: "ROBOT-19",
      kind: "task",
      moduleId: MECH,
      moduleName: "Механика",
      stateName: "В работе",
    });
    expect(items[1]).toMatchObject({ moduleName: "Презентация", stateGroup: "backlog", stateName: "Бэклог" });
    expect(items[2]).toMatchObject({ moduleId: null, moduleName: null });
    expect(items[3]).toMatchObject({
      entityId: uuid(40_050),
      kind: "pull_request",
      moduleId: MECH,
      ref: "#50",
      workItemIdentifier: "ROBOT-16",
    });
    expect(trayPlacementRequest(items[2], "Без направления")).toEqual({
      entityId: uuid(21),
      entityType: "work_item",
      key: `task:${uuid(21)}`,
      moduleId: null,
      sectionTitle: "Без направления",
      size: { h: 248, w: 360 },
    });
    expect(trayPlacementRequest(items[3], "Без направления")).toMatchObject({
      entityId: uuid(40_050),
      entityType: "pull_request",
      size: { h: 220, w: 360 },
    });
  });

  it("offers the tray only on a map whose sprint has been read", () => {
    const view = computeLivingMapView({
      cards: [],
      data: {
        ...EMPTY_LIVING_MAP_DATA,
        cycleId: CURRENT.id,
        issues: new Map([[uuid(19), issue(19, [MECH])]]),
        sprintIssueIds: [uuid(19)],
      },
      groups: mapGroupsOf([{ id: "shape:frame", node: FRAME_NODE, parentId: "page:page" }]),
      options: { assignees: [], priorities: [], states: STATES },
      projectId: PROJECT,
      projectIdentifier: "ROBOT",
      today: new Date(2026, 8, 26),
    });
    expect(view.tray).toMatchObject({ builtAt: NOW, enabled: true });
    expect(view.tray.items).toHaveLength(1);
    const plain = computeLivingMapView({
      cards: [],
      data: EMPTY_LIVING_MAP_DATA,
      groups: [],
      options: { assignees: [], priorities: [], states: STATES },
      projectId: PROJECT,
      projectIdentifier: "ROBOT",
      today: new Date(2026, 8, 26),
    });
    expect(plain.tray.enabled).toBe(false);
  });
});

describe("AF2.2 M4: куда класть", () => {
  it("fills the first free cell of the direction's section, holes and a user's note included", () => {
    expect(planMapPlacement(mapState([0, 2]), [request("task:1", MECH)]).cards).toEqual([
      { key: "task:1", parent: { id: "shape:mech", kind: "section" }, x: 392, y: 48 },
    ]);
    const noted = planMapPlacement(mapState([0], [{ h: 220, w: 320, x: 20, y: 60 }]), [request("task:2", SOFT)]);
    expect(noted.cards[0]).toMatchObject({ x: 392, y: 48 });
    expect(noted.sectionHeights).toEqual([]);
    expect(noted.frameHeight).toBeNull();
  });

  it("grows a full section by a row and moves everything below it down, the frame too", () => {
    const plan = planMapPlacement(mapState([0, 1, 2, 3]), [request("task:3", MECH), request("task:4", MECH)]);
    expect(plan.cards.map(({ x, y }) => [x, y])).toEqual([
      [16, 312],
      [392, 312],
    ]);
    expect(plan.sectionHeights).toEqual([{ h: 576, id: "shape:mech", node: section(MECH, 312) }]);
    expect(plan.moves).toEqual([{ id: "shape:soft", type: "ppm-canvas-node", y: 664 }]);
    expect(plan.frameHeight).toBe(1000);
  });

  it("opens a missing direction's section at the bottom of the frame", () => {
    const plan = planMapPlacement(mapState([0, 1, 2, 3]), [request("task:5", PRES)]);
    expect(plan.newSections).toEqual([
      { h: 312, key: PRES, moduleId: PRES, title: "Презентация", w: 1520, x: 24, y: 736 },
    ]);
    expect(plan.cards).toEqual([{ key: "task:5", parent: { key: PRES, kind: "new" }, x: 16, y: 48 }]);
    expect(plan.frameHeight).toBe(1072);
  });

  it("reads the map from the board: sections by the frame's children, their children, other frame children", () => {
    const state = mapStateFromRecords(
      [
        {
          h: 736,
          id: "shape:frame",
          node: FRAME_NODE,
          parentId: "page:page",
          type: "ppm-canvas-node",
          w: 1568,
          x: 0,
          y: 0,
        },
        {
          h: 312,
          id: "shape:mech",
          node: section(MECH, 312),
          parentId: "shape:frame",
          type: "ppm-canvas-node",
          w: 1520,
          x: 24,
          y: 64,
        },
        { h: 248, id: "shape:c5", node: null, parentId: "shape:mech", type: "ppm-canvas-node", w: 360, x: 16, y: 48 },
        { h: 200, id: "shape:sticker", node: null, parentId: "shape:frame", type: "note", w: 200, x: 24, y: 400 },
      ],
      "shape:frame"
    );
    expect(state?.sections.map((item) => [item.id, item.moduleId, item.children])).toEqual([
      ["shape:mech", MECH, [{ h: 248, w: 360, x: 16, y: 48 }]],
    ]);
    expect(state?.others).toEqual([{ h: 200, id: "shape:sticker", type: "note", w: 200, x: 24, y: 400 }]);
    expect(mapStateFromRecords([], "shape:frame")).toBeNull();
  });
});

describe("AF2.2 M4: раскладка по нажатию", () => {
  it("plans against the board as it is after the request and grows the section in the same change", async () => {
    const states = [mapState([0, 1, 2]), mapState([0, 1, 2, 3])];
    const readState = vi.fn(() => states.shift() ?? null);
    const applied: TMapShapeChange[] = [];
    const registerBindings = vi.fn();
    const result = await placeOnMap(
      {
        applyChange: (change) => {
          applied.push(change);
          return true;
        },
        authorId: USER,
        bindBatch: async (items: readonly TPpmCanvasBatchBindingItem[]) =>
          items.map(
            (item): TPpmCanvasBatchBindingResult => ({
              binding: workItemBinding(seqOf(item.entity_id), item.shape_id),
              shape_id: item.shape_id,
              status: "created",
            })
          ),
        cancelBinding: vi.fn(async () => undefined),
        newShapeId: counter("shape:n"),
        now: () => NOW,
        readState,
        registerBindings,
      },
      [request("task:19", MECH)]
    );
    expect(readState).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ cardIds: ["shape:n1"], failed: 0, placed: 1 });
    const [change] = applied;
    expect(change.create.map((shape) => [shape.id, shape.parentId, shape.x, shape.y])).toEqual([
      ["shape:n1", "shape:mech", 16, 312],
    ]);
    const grown = change.update.find((shape) => shape.id === "shape:mech");
    expect(grown?.props?.h).toBe(576);
    const parsed = parseSerializedPpmCanvasNode(grown?.props?.node ?? "");
    expect(parsed.status === "valid" && parsed.node.visual.height).toBe(576);
    expect(change.moves).toEqual([{ id: "shape:soft", type: "ppm-canvas-node", y: 664 }]);
    expect(change.update.find((shape) => shape.id === "shape:frame")?.props?.h).toBe(1000);
    expect(registerBindings.mock.calls[0][0].map((binding: { entity_id: string }) => binding.entity_id)).toEqual([
      uuid(19),
    ]);
  });

  it("cancels bindings whose card cannot be drawn and everything when the board refused the change", async () => {
    const cancelBinding = vi.fn(async () => undefined);
    const pr: TMapPlacementRequest = {
      ...request("pr:50", MECH, { h: 220, w: 360 }),
      entityId: uuid(40_050),
      entityType: "pull_request",
    };
    const bindBatch = async (items: readonly TPpmCanvasBatchBindingItem[]) =>
      items.map(
        (item): TPpmCanvasBatchBindingResult =>
          item.entity_type === "pull_request"
            ? {
                binding: pullRequestBinding(50, item.shape_id, "http://git.example.org/pull/50"),
                shape_id: item.shape_id,
                status: "created",
              }
            : {
                binding: workItemBinding(seqOf(item.entity_id), item.shape_id),
                shape_id: item.shape_id,
                status: "created",
              }
      );
    const base = {
      authorId: USER,
      bindBatch,
      cancelBinding,
      newShapeId: counter("shape:p"),
      now: () => NOW,
      readState: () => mapState([0]),
      registerBindings: vi.fn(),
    };
    const drawn = await placeOnMap({ ...base, applyChange: () => true }, [request("task:19", MECH), pr]);
    expect(drawn).toMatchObject({ failed: 1, placed: 1 });
    expect(cancelBinding).toHaveBeenCalledWith(uuid(60_050));
    cancelBinding.mockClear();
    const refused = await placeOnMap({ ...base, applyChange: () => false }, [request("task:19", MECH)]);
    expect(refused).toEqual({ cardIds: [], failed: 1, placed: 0 });
    expect(cancelBinding).toHaveBeenCalledWith(uuid(50_019));
  });

  it("builds a new section node for a missing direction with the map role", () => {
    const plan = planMapPlacement(mapState([0]), [request("task:5", PRES)]);
    const built = buildPlacementChange({
      authorId: USER,
      bindings: new Map([["task:5", workItemBinding(5, "shape:c5")]]),
      frameId: "shape:frame",
      frameNode: FRAME_NODE,
      newSectionId: () => "shape:pres",
      now: NOW,
      plan,
      shapeIds: new Map([["task:5", "shape:c5"]]),
    });
    const created = built.change.create.find((shape) => shape.id === "shape:pres");
    const node = parseSerializedPpmCanvasNode(created?.props?.node ?? "");
    expect(node.status === "valid" && node.node.kind === "group" && node.node.map).toEqual({
      module_id: PRES,
      role: "section",
    });
    expect(created).toMatchObject({ parentId: "shape:frame", x: 24, y: 736 });
    expect(built.change.create.find((shape) => shape.id === "shape:c5")).toMatchObject({
      parentId: "shape:pres",
      x: 16,
      y: 48,
    });
    expect(built.cardIds).toEqual(["shape:c5"]);
  });

  it("places only for an editor of the active tab and shows the tray to readers without buttons", () => {
    const hook = read("living-map/living-map-facts.ts");
    has(
      hook,
      "if (!current.enabled || !current.canEdit || !current.isActive || !activeEditor || !frameId || placingRef.current) return null;"
    );
    // Ревью M4, раунд 1: отбор нажатия (RM-c → ≤ 200 → место в сохранении) — чистая selectTrayRequests; предел 200
    // проверяет её поведенческий тест ниже.
    has(hook, "selectTrayRequests({ bindings: current.bindingsByShapeId,");
    has(hook, "registerBindings: current.registerBindings }");
    const tray = read("living-map/not-on-map-tray.tsx");
    has(tray, "if (!args.enabled || !tray?.enabled || tray.items.length === 0) return null;");
    has(tray, "const canPlace = args.canEdit && Boolean(placeFromTray);");
    expect(tray.match(/\{canPlace && \(/g)?.length).toBe(2);
    has(tray, "void place(tray.items.map((item) => item.key))");
    expect(tray).toContain("ppm-living-map-panel");
  });

  it("names the tray in both languages", () => {
    expect(getPpmTranslation("ru", "canvas.tray.title")).toBe("Не на карте");
    expect(getPpmTranslation("ru", "canvas.tray.place_all")).toBe("Разложить всё");
    expect(fillCanvasTemplate(getPpmTranslation("ru", "canvas.tray.place_label"), { name: "ROBOT-19" })).toBe(
      "Добавить ROBOT-19 на карту"
    );
    expect(getPpmTranslation("en", "canvas.tray.title")).toBe("Not on the map");
  });
});

// ─────────────── Решения контроллера (RM-b, RM-c, RM-d) и предел рамки (ревью M1) ───────────────

/** Задача 16 спринта и два её PR: #50 с объектом Git и ручная ссылка #51 без него. */
function trayItems() {
  return collectNotOnMap({
    cards: [],
    issues: new Map([issue(16, [MECH], { assignee_ids: [uuid(5001)] })].map((item) => [item.id, item])),
    modules: new Map(MODULES.map((item) => [item.id, item])),
    options: { assignees: PEOPLE, priorities: [], states: STATES },
    projectIdentifier: "ROBOT",
    pullRequests: [pullRequestLink(50, 16), pullRequestLink(51, 16, { git_object_id: null })],
    sprintIssueIds: [uuid(16)],
  });
}

/** Карта у предела группы: под полной секцией «Механика» — стикер, низ рамки 19 800; ещё ряд (+264) — 20 064. */
function nearLimit(): TMapState {
  const state = mapState([0, 1, 2, 3]);
  return {
    ...state,
    frame: { ...state.frame, h: 19_800 },
    others: [{ h: 276, id: "shape:sticker", type: "note", w: 200, x: 24, y: 19_500 }],
  };
}

const createdBindings = async (items: readonly TPpmCanvasBatchBindingItem[]) =>
  items.map(
    (item): TPpmCanvasBatchBindingResult => ({
      binding: workItemBinding(seqOf(item.entity_id), item.shape_id),
      shape_id: item.shape_id,
      status: "created",
    })
  );

/** Привязки доски: первые pending — положены, но ещё не сохранены; остальные active. */
function bindingsOf(pending: number, active: number) {
  return new Map(
    Array.from({ length: pending + active }, (_, index) => {
      const binding = workItemBinding(index + 1, `shape:b${index}`);
      return [binding.shape_id, index < pending ? binding : { ...binding, binding_status: "active" as const }];
    })
  );
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    values,
  };
}

/** Лоток так, как его монтирует CanvasControls: внутри провайдера «Живой карты» своей доски (облик v2). */
function renderTray(args: Partial<TLivingMapArgs>, tray: TLivingMapTray | undefined): string {
  return renderToStaticMarkup(
    createElement(
      PpmLivingMapContext.Provider,
      {
        value: {
          ...PPM_LIVING_MAP_DEFAULT,
          args: { ...EMPTY_LIVING_MAP_ARGS, authorId: USER, boardId: BOARD, enabled: true, ...args },
          placeFromTray: async () => null,
          tray,
        },
      },
      createElement(PpmNotOnMapTray)
    )
  );
}

describe("AF2.2 M4: решения контроллера и предел рамки", () => {
  it("keeps a manual PR link without a Git object in the tray but never places it (RM-c)", () => {
    expect(trayItems().map((item) => [item.key, isPlaceableTrayItem(item)])).toEqual([
      [`task:${uuid(16)}`, true],
      [`pr:${uuid(30_050)}`, true],
      [`pr:${uuid(30_051)}`, false],
    ]);
    // «+ Добавить» и «Разложить всё» идут через selectTrayRequests: ручную ссылку он отбрасывает до запроса S1.
    const items = trayItems();
    const keys = items.map((item) => item.key);
    const selection = selectTrayRequests({ bindings: new Map(), items, keys, noDirectionTitle: "Без направления" });
    expect(selection?.requests.map((item) => item.key)).toEqual([`task:${uuid(16)}`, `pr:${uuid(30_050)}`]);
    expect(
      selectTrayRequests({ bindings: new Map(), items, keys: [`pr:${uuid(30_051)}`], noDirectionTitle: "—" })
    ).toBeNull();
    expect(getPpmTranslation("ru", "canvas.tray.pr_no_git_object")).toBe(
      "Эту ссылку нельзя положить на доску: у неё нет объекта Git"
    );
  });

  it("renders the list for everyone, the buttons for editors only and a hint on a link without a Git object", () => {
    const tray: TLivingMapTray = { builtAt: NOW, enabled: true, items: trayItems() };
    // Лоток открывается свёрнутым (ревью M4, раунд 1); здесь пользователь его уже развернул на этой доске.
    writeTrayExpanded(undefined, trayStorageKey(USER, BOARD), true);
    const editor = renderTray({ canEdit: true }, tray);
    for (const marker of [
      'aria-label="Не на карте: 3"',
      "Разложить всё",
      "ROBOT-16",
      "PR #50",
      "PR #51",
      "к ROBOT-16",
      "В работе · Миша К.",
      "Карта собрана",
    ])
      expect(editor, marker).toContain(marker);
    const addButton = (name: string) =>
      new RegExp(`<button[^>]*aria-label="Добавить ${name} на карту"[^>]*>`).exec(editor)?.[0] ?? "";
    expect(addButton("ROBOT-16")).toMatch(/^<button/);
    expect(addButton("ROBOT-16")).not.toContain("disabled");
    expect(addButton("PR #50")).not.toContain("disabled");
    // RM-c (ревью M4, раунд 1): не native disabled — кнопка остаётся в порядке Tab, щелчок ничего не делает.
    expect(addButton("PR #51")).toContain('aria-disabled="true"');
    expect(addButton("PR #51")).not.toMatch(/ disabled=""/);
    expect(addButton("PR #51")).toContain('title="Эту ссылку нельзя положить на доску: у неё нет объекта Git"');
    expect(addButton("PR #51")).toMatch(/aria-describedby="[^"]+"/);
    expect(editor).toContain('class="ppm-not-on-map__hint"');
    expect(editor).not.toContain("Разложить нечего");
    // Только ручные ссылки — «Разложить всё» класть нечего.
    const linkless = renderTray(
      { canEdit: true },
      { ...tray, items: tray.items.filter((item) => !isPlaceableTrayItem(item)) }
    );
    const placeAll = /<button[^>]*class="ppm-not-on-map__all"[^>]*>/.exec(linkless)?.[0] ?? "";
    expect(placeAll).toContain('aria-disabled="true"');
    expect(placeAll).toMatch(/aria-describedby="[^"]+"/);
    expect(linkless).toContain("Разложить нечего: ссылки без объекта Git нельзя положить на доску");
    // Читатель видит список без кнопок и без подсказки для редактора.
    const reader = renderTray({ canEdit: false }, tray);
    expect(reader).toContain("ROBOT-16");
    expect(reader).toContain("Добавлять на карту могут редакторы доски");
    for (const absent of ["ppm-not-on-map__add", "ppm-not-on-map__all", "ppm-not-on-map__hint"])
      expect(reader, absent).not.toContain(absent);
    // Облик v1, доска без рамки спринта, пустой лоток — лотка нет.
    expect(renderTray({ canEdit: true, enabled: false }, tray)).toBe("");
    expect(renderTray({ canEdit: true }, undefined)).toBe("");
    expect(renderTray({ canEdit: true }, { ...tray, items: [] })).toBe("");
  });

  it("hides the inspector while the tray is open, as «Что изменилось» does (RM-b)", () => {
    const css = read("living-map/living-map.css");
    const m = css.slice(css.indexOf("/* ── M: "), css.indexOf("/* ── /M ── */"));
    has(
      m,
      ':where(html[data-ppm-design="v2"]) [data-ppm-canvas-grammar="v2"] .tl-container:has(.ppm-not-on-map__list) ~ .ppm-canvas-inspector { display: none; }'
    );
    // Список (а с ним и правило) есть только у развёрнутого лотка; свёрнутый инспектор не прячет.
    has(read("living-map/not-on-map-tray.tsx"), '{expanded && (<ul className="ppm-not-on-map__list">');
  });

  it("places at most 200 cards per press, counts the board's unsaved ones and asks to press again (RM-d)", () => {
    expect(placementRoom(new Map())).toBe(200);
    expect(placementRoom(bindingsOf(150, 10))).toBe(50);
    expect(placementRoom(bindingsOf(230, 0))).toBe(0);
    has(read("living-map/living-map-facts.ts"), "return { ...result, remaining };");
    const notice = (result: TPlaceOnMapResult) => {
      const { key, values } = trayPlacementNotice(result);
      return fillCanvasTemplate(getPpmTranslation("ru", key), values);
    };
    expect(notice({ cardIds: [], failed: 0, placed: 200, remaining: 30 })).toBe(
      "Добавлено 200 — нажмите ещё раз, чтобы добавить остальные"
    );
    expect(notice({ cardIds: [], failed: 0, placed: 3, remaining: 0 })).toBe("Добавлено на карту: 3");
    expect(notice({ cardIds: [], failed: 2, placed: 3 })).toBe("Добавлено на карту: 3, не добавлено: 2");
    // Ревью M4, раунд 1: часть не легла, а за нажатие взяли не всё — «нажмите ещё раз» остаётся.
    expect(notice({ cardIds: [], failed: 2, placed: 3, remaining: 40 })).toBe(
      "Добавлено на карту: 3, не добавлено: 2 — нажмите ещё раз, чтобы добавить остальные"
    );
    expect(notice({ cardIds: [], failed: 1, placed: 0 })).toBe("Не удалось добавить на карту");
    expect(notice({ cardIds: [], failed: 0, placed: 0, remaining: 4 })).toBe(
      "Доска ещё сохраняется — нажмите ещё раз через секунду"
    );
    expect(notice({ cardIds: [], failed: 1, noRoom: true, placed: 0 })).toMatch(/^На карте нет места — /);
    has(read("living-map/not-on-map-tray.tsx"), "const { key, values } = trayPlacementNotice(result);");
  });

  it("keeps the sprint frame within the group limit: binds and draws nothing that would outgrow it", async () => {
    expect(MAP_FRAME_MAX_HEIGHT).toBe(20_000);
    expect(mapPlacementFits(planMapPlacement(nearLimit(), [request("task:19", SOFT)]))).toBe(true);
    expect(mapPlacementFits(planMapPlacement(nearLimit(), [request("task:19", MECH)]))).toBe(false);
    expect(mapPlacementFits(planMapPlacement(nearLimit(), [request("task:5", PRES)]))).toBe(false);
    const bindBatch = vi.fn(createdBindings);
    const cancelBinding = vi.fn(async () => undefined);
    const applyChange = vi.fn(() => true);
    const registerBindings = vi.fn();
    const deps = {
      applyChange,
      authorId: USER,
      bindBatch,
      cancelBinding,
      newShapeId: counter("shape:t"),
      now: () => NOW,
      registerBindings,
    };
    // Не помещается уже до запроса — S1 не зовём: ничего не создано, отменять нечего.
    expect(await placeOnMap({ ...deps, readState: nearLimit }, [request("task:19", MECH)])).toEqual({
      cardIds: [],
      failed: 1,
      noRoom: true,
      placed: 0,
    });
    expect(bindBatch).not.toHaveBeenCalled();
    // Пока шёл S1, доска доросла до предела: созданные привязки отменяются, доска не меняется.
    const states = [mapState([0, 1, 2, 3]), nearLimit()];
    expect(await placeOnMap({ ...deps, readState: () => states.shift() ?? null }, [request("task:19", MECH)])).toEqual({
      cardIds: [],
      failed: 1,
      noRoom: true,
      placed: 0,
    });
    expect(bindBatch).toHaveBeenCalledTimes(1);
    expect(cancelBinding).toHaveBeenCalledWith(uuid(50_019));
    expect(applyChange).not.toHaveBeenCalled();
    expect(registerBindings).not.toHaveBeenCalled();
    expect(getPpmTranslation("ru", "canvas.tray.no_room")).toMatch(/^На карте нет места — /);
  });

  it("cancels every binding S1 created when anything after it throws", async () => {
    const cancelBinding = vi.fn(async () => undefined);
    const registerBindings = vi.fn();
    await expect(
      placeOnMap(
        {
          applyChange: () => true,
          authorId: USER,
          bindBatch: createdBindings,
          cancelBinding,
          newShapeId: counter("shape:x"),
          now: () => {
            throw new Error("clock");
          },
          readState: () => mapState([0]),
          registerBindings,
        },
        [request("task:19", MECH), request("task:20", SOFT)]
      )
    ).rejects.toThrow("clock");
    expect(cancelBinding).toHaveBeenCalledTimes(2);
    expect(cancelBinding).toHaveBeenCalledWith(uuid(50_019));
    expect(cancelBinding).toHaveBeenCalledWith(uuid(50_020));
    expect(registerBindings).not.toHaveBeenCalled();
  });
});

describe("AF2.2 M4: исправления ревью, раунд 1", () => {
  it("lists a PR linked to two sprint tasks once, under the first of them", () => {
    const items = collectNotOnMap({
      cards: [],
      issues: new Map([issue(16, [MECH]), issue(19, [SOFT])].map((item) => [item.id, item])),
      modules: new Map(MODULES.map((item) => [item.id, item])),
      options: { assignees: PEOPLE, priorities: [], states: STATES },
      projectIdentifier: "ROBOT",
      pullRequests: [
        pullRequestLink(52, 19, { git_object_id: uuid(40_050) }),
        pullRequestLink(50, 16),
        pullRequestLink(51, 16, { git_object_id: null }),
        pullRequestLink(53, 19, { git_object_id: null }),
      ],
      sprintIssueIds: [uuid(16), uuid(19)],
    });
    // PR #50 связан с ROBOT-16 и ROBOT-19 (две Git-связи, один объект Git) — один пункт, одна карточка.
    expect(items.filter((item) => item.kind === "pull_request").map((item) => item.key)).toEqual([
      `pr:${uuid(30_050)}`,
      `pr:${uuid(30_051)}`,
      `pr:${uuid(30_053)}`,
    ]);
    expect(items.find((item) => item.key === `pr:${uuid(30_050)}`)).toMatchObject({
      entityId: uuid(40_050),
      moduleId: MECH,
      workItemIdentifier: "ROBOT-16",
    });
  });

  it("keeps the cards laid out here but not saved yet through the periodic refresh", () => {
    const saved = { ...workItemBinding(5, "shape:c5"), binding_status: "active" as const };
    const placed = workItemBinding(19, "shape:c19");
    const cancelled = workItemBinding(20, "shape:c20");
    const savedMeanwhile = { ...workItemBinding(21, "shape:c21"), binding_status: "active" as const };
    const local = new Map([
      [saved.shape_id, saved],
      [placed.shape_id, placed],
      [cancelled.shape_id, cancelled],
      [savedMeanwhile.shape_id, savedMeanwhile],
    ]);
    const fresh = { ...saved, source_version: "2" };
    // Сервер отдаёт только active. Карточка ROBOT-19 положена и ждёт сохранения, ROBOT-21 сохранили, пока шёл опрос, —
    // обе остаются; ROBOT-20 вне очереди (сохранение с конфликтом её отменило) — уходит; ROBOT-5 — версия сервера.
    const merged = mergeRefreshedBindings(local, [fresh], new Set([placed.binding_id, savedMeanwhile.binding_id]));
    expect([...merged.keys()]).toEqual(["shape:c5", "shape:c19", "shape:c21"]);
    expect(merged.get("shape:c5")).toBe(fresh);
    expect(merged.get("shape:c19")).toBe(placed);
    // Сервер уже знает привязку фигуры — его версия важнее локальной.
    const activated = { ...placed, binding_status: "active" as const };
    expect(mergeRefreshedBindings(local, [activated], new Set([placed.binding_id])).get("shape:c19")).toBe(activated);
    // Опрос editor.tsx (раз в 30 с и при фокусе окна) — один размеченный блок M: очередь активаций и сохранение в пути
    // на момент запроса и ответа.
    const editor = read("editor.tsx");
    const refresh = editor.slice(
      editor.indexOf("const refreshWorkItems = useCallback("),
      editor.indexOf("setWorkItemOptions(response.work_item_options);")
    );
    has(refresh, "setBindingsByShapeId((current) => mergeRefreshedBindings(current, response.bindings, unsaved));");
    has(refresh, "...queuedBindingActivationsRef.current,");
    has(refresh, "...(pendingSaveRef.current?.binding_changes.activate ?? [])");
    expect(refresh.split("── AF2.2 M:").length - 1).toBe(1);
    expect(refresh.split("── /AF2.2 M ──").length - 1).toBe(1);
    expect(refresh).not.toContain("setBindingsByShapeId(new Map(response.bindings");
  });

  it("selects what one press places: placeable items, at most 200, within the next save's room", () => {
    const many = collectNotOnMap({
      cards: [],
      issues: new Map(
        Array.from({ length: 250 }, (_, index) => issue(index + 1, [MECH])).map((item) => [item.id, item])
      ),
      modules: new Map(MODULES.map((item) => [item.id, item])),
      options: { assignees: PEOPLE, priorities: [], states: STATES },
      projectIdentifier: "ROBOT",
      pullRequests: [],
      sprintIssueIds: Array.from({ length: 250 }, (_, index) => uuid(index + 1)),
    });
    const keys = many.map((item) => item.key);
    const select = (bindings: ReturnType<typeof bindingsOf>) =>
      selectTrayRequests({ bindings, items: many, keys, noDirectionTitle: "Без направления" });
    // «Разложить всё» на 250 задач: первые 200 по порядку лотка, 50 ждут следующего нажатия.
    const first = select(bindingsOf(0, 0));
    expect(first?.requests).toHaveLength(200);
    expect(first?.requests[0]).toMatchObject({ entityId: uuid(1), entityType: "work_item", key: `task:${uuid(1)}` });
    expect(first?.remaining).toBe(50);
    // 150 карточек уже положены и не сохранены — ближайшее сохранение активирует ещё 50.
    expect(select(bindingsOf(150, 30))).toMatchObject({ remaining: 200 });
    expect(select(bindingsOf(150, 30))?.requests).toHaveLength(50);
    // Места в сохранении нет — запроса нет, «нажмите ещё раз»; пункт по одному — только он.
    expect(select(bindingsOf(200, 0))).toEqual({ remaining: 250, requests: [] });
    expect(
      selectTrayRequests({ bindings: new Map(), items: many, keys: [`task:${uuid(7)}`], noDirectionTitle: "—" })
    ).toMatchObject({ remaining: 0, requests: [{ key: `task:${uuid(7)}` }] });
    const hook = read("living-map/living-map-facts.ts");
    has(hook, "if (!selection) return null;");
    has(hook, "if (requests.length === 0) return { cardIds: [], failed: 0, placed: 0, remaining };");
  });

  it("starts collapsed and remembers the choice per board in the browser", () => {
    const key = trayStorageKey(USER, uuid(9101));
    expect(key).toBe(`ppm:af22:not-on-map:${USER}:${uuid(9101)}`);
    const storage = memoryStorage();
    expect(readTrayExpanded(storage, key)).toBe(false);
    writeTrayExpanded(storage, key, true);
    expect(storage.values.get(key)).toBe("expanded");
    expect(readTrayExpanded(storage, key)).toBe(true);
    // После перезагрузки выбор читается из браузера; хранилище, которое бросает (приватный режим), — «свёрнут».
    const saved = trayStorageKey(USER, uuid(9102));
    expect(readTrayExpanded(memoryStorage({ [saved]: "expanded" }), saved)).toBe(true);
    const denied = {
      getItem: (): string | null => {
        throw new Error("denied");
      },
      setItem: (): void => {
        throw new Error("denied");
      },
    };
    const deniedKey = trayStorageKey(USER, uuid(9103));
    expect(readTrayExpanded(denied, deniedKey)).toBe(false);
    writeTrayExpanded(denied, deniedKey, true);
    expect(readTrayExpanded(denied, deniedKey)).toBe(true);
    // Новая доска: только шапка «Не на карте · N» с кнопкой «Развернуть», списка нет — инспектор на карте виден (RM-b).
    const tray: TLivingMapTray = { builtAt: NOW, enabled: true, items: trayItems() };
    const collapsed = renderTray({ boardId: uuid(9104), canEdit: true }, tray);
    for (const marker of ['aria-label="Не на карте: 3"', 'aria-expanded="false"', "Развернуть список", "Разложить всё"])
      expect(collapsed, marker).toContain(marker);
    for (const absent of ["ppm-not-on-map__list", "ppm-not-on-map__add", "Карта собрана"])
      expect(collapsed, absent).not.toContain(absent);
  });

  it("lays a new direction's section across the frame's current width", () => {
    // Рамку сузили до двух колонок (816): новая секция — во всю ширину рамки без полей, карточки — в две колонки.
    const narrow: TMapState = {
      frame: { h: 400, id: "shape:frame", node: FRAME_NODE, w: 816 },
      others: [],
      sections: [],
    };
    const plan = planMapPlacement(narrow, [request("task:5", PRES), request("task:6", PRES), request("task:7", PRES)]);
    expect(plan.newSections).toEqual([
      { h: 576, key: PRES, moduleId: PRES, title: "Презентация", w: 768, x: 24, y: 64 },
    ]);
    expect(plan.cards.map(({ x, y }) => [x, y])).toEqual([
      [16, 48],
      [392, 48],
      [16, 312],
    ]);
    expect(plan.frameHeight).toBe(664);
    // Уже карточки — секция не уже одной карточки с полями.
    const tiny = planMapPlacement({ ...narrow, frame: { ...narrow.frame, w: 300 } }, [request("task:5", PRES)]);
    expect(tiny.newSections[0]?.w).toBe(392);
  });
});

describe("AF2.2 финальная волна (FW-W)", () => {
  it("leaves out PRs closed without a merge; merged, open and those from an older server stay (M-6)", () => {
    // Сервер (FW-S) отдаёт у Git-связи состояние объекта: open | closed | merged | null; старый сервер — поля нет.
    const links = parseMapList(mapPullRequestSchema, [
      { ...pullRequestLink(50, 16), git_object_state: "closed" },
      { ...pullRequestLink(51, 16), git_object_state: "merged" },
      { ...pullRequestLink(52, 16), git_object_state: "open" },
      pullRequestLink(53, 5),
      { ...pullRequestLink(54, 5), git_object_state: null },
      { ...pullRequestLink(55, 5), git_object_state: 7 },
    ]);
    expect(links.map((link) => link.git_object_state)).toEqual(["closed", "merged", "open", undefined, null, null]);
    const items = collectNotOnMap({
      cards: [],
      issues: new Map([issue(5, [MECH]), issue(16, [MECH])].map((item) => [item.id, item])),
      modules: new Map(MODULES.map((item) => [item.id, item])),
      options: { assignees: PEOPLE, priorities: [], states: STATES },
      projectIdentifier: "ROBOT",
      pullRequests: links,
      sprintIssueIds: [uuid(5), uuid(16)],
    });
    expect(items.filter((item) => item.kind === "pull_request").map((item) => item.key)).toEqual([
      `pr:${uuid(30_053)}`,
      `pr:${uuid(30_054)}`,
      `pr:${uuid(30_055)}`,
      `pr:${uuid(30_051)}`,
      `pr:${uuid(30_052)}`,
    ]);
  });

  it("memoizes the tray: a long list is not rebuilt on every drag frame of CanvasControls (M-2)", () => {
    expect(read("living-map/not-on-map-tray.tsx")).toContain(
      "export const PpmNotOnMapTray = memo(function PpmNotOnMapTray() {"
    );
    expect((PpmNotOnMapTray as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for("react.memo"));
    // Без пропсов — memo отсекает каждую перерисовку CanvasControls; данные лотка — только из контекста карты.
    expect(read("editor.tsx")).toContain("<PpmNotOnMapTray />");
  });
});
