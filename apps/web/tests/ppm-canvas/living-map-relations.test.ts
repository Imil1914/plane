// AF2.2 M2: связи Plane «из Задач» между живыми карточками — типы, направление, одна линия на пару, данные одним
// запросом; слой только читает и рисует в html-слое фигур tldraw (под карточками, без перерисовок на кадрах камеры).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getPpmTranslation } from "@ppm/brand";
import { createPpmSprintFrameNode, serializePpmCanvasNode } from "@ppm/canvas";
import { computeLivingMapView, loadLivingMapData } from "@/components/ppm-canvas/living-map/map-data";
import { mapGroupsOf } from "@/components/ppm-canvas/living-map/map-model";
import {
  collectTaskRelations,
  planeRelationLink,
  TASK_LINK_LABEL_KEYS,
  TLDRAW_SHAPES_LAYER_SELECTOR,
} from "@/components/ppm-canvas/living-map/task-relations";
import { SEMANTIC_EDGE_STYLE } from "@/components/ppm-canvas/semantic-edge-style";
import {
  CURRENT,
  issue,
  MODULES,
  norm,
  NOW,
  PROJECT,
  relation,
  STATES,
  USER,
  uuid,
  workItemBinding,
} from "./fixtures/living-map";

const dir = new URL("../../core/components/ppm-canvas/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
const has = (source: string, needle: string) => expect(norm(source), needle).toContain(norm(needle));
const card = (seq: number, shapeId: string) => ({ identifier: `ROBOT-${seq}`, shapeId, workItemId: uuid(seq) });

describe("AF2.2 M2: связи «из Задач»", () => {
  it("maps Plane relation kinds to the canvas link kinds and skips duplicates and reverse sides", () => {
    expect(
      [
        "blocked_by",
        "start_before",
        "finish_before",
        "relates_to",
        "implemented_by",
        "duplicate",
        "blocking",
        "custom",
      ].map(planeRelationLink)
    ).toEqual(["blocks", "depends_on", "depends_on", "relates_to", "implements", null, null, null]);
    expect(SEMANTIC_EDGE_STYLE.blocks).toMatchObject({ end: "bar", tone: "danger" });
    expect(SEMANTIC_EDGE_STYLE.depends_on.end).toBe("arrow");
    expect(SEMANTIC_EDGE_STYLE.relates_to.end).toBe("none");
    expect(TASK_LINK_LABEL_KEYS.blocks).toBe("canvas.map.relation_blocks");
  });

  it("draws from the blocker to the blocked task, from the dependent task, one line per related pair", () => {
    const issues = [
      issue(15, [], { issue_relation: [relation(12, "blocked_by")] }),
      issue(16, [], { issue_relation: [relation(15, "start_before"), relation(5, "relates_to")] }),
      issue(5, [], {
        issue_relation: [relation(16, "relates_to"), relation(12, "duplicate"), relation(99, "blocked_by")],
      }),
      issue(12),
    ];
    const cards = [card(12, "shape:a"), card(15, "shape:b"), card(16, "shape:c"), card(5, "shape:d")];
    expect(collectTaskRelations(issues, cards)).toEqual([
      {
        fromLabel: "ROBOT-12",
        fromShapeId: "shape:a",
        id: `blocks:${uuid(12)}:${uuid(15)}`,
        kind: "blocks",
        toLabel: "ROBOT-15",
        toShapeId: "shape:b",
      },
      {
        fromLabel: "ROBOT-15",
        fromShapeId: "shape:b",
        id: `depends_on:${uuid(15)}:${uuid(16)}`,
        kind: "depends_on",
        toLabel: "ROBOT-16",
        toShapeId: "shape:c",
      },
      {
        fromLabel: "ROBOT-5",
        fromShapeId: "shape:d",
        id: `relates_to:${uuid(5)}:${uuid(16)}`,
        kind: "relates_to",
        toLabel: "ROBOT-16",
        toShapeId: "shape:c",
      },
    ]);
  });

  it("links a task placed twice through its card with the smaller id and ignores tasks off the board", () => {
    const issues = [issue(9, [], { issue_relation: [relation(7, "implemented_by"), relation(40, "relates_to")] })];
    const cards = [card(9, "shape:z"), card(9, "shape:b"), card(7, "shape:k")];
    expect(collectTaskRelations(issues, cards)).toEqual([
      {
        fromLabel: "ROBOT-7",
        fromShapeId: "shape:k",
        id: `implements:${uuid(7)}:${uuid(9)}`,
        kind: "implements",
        toLabel: "ROBOT-9",
        toShapeId: "shape:b",
      },
    ]);
  });

  it("reads the sprint with its links in one request and the project list only for tasks outside the sprint", async () => {
    const sprint = [issue(12), issue(15, [], { issue_relation: [relation(12, "blocked_by")] })];
    const loaders = {
      cycle: vi.fn(async () => CURRENT),
      modules: vi.fn(async () => MODULES),
      projectIssues: vi.fn(async () => [
        issue(40, [], { cycle_id: null, issue_relation: [relation(15, "relates_to")] }),
      ]),
      pullRequests: vi.fn(async () => []),
      sprintIssues: vi.fn(async () => sprint),
    };
    const inSprint = await loadLivingMapData(loaders, {
      boardWorkItemIds: [uuid(12), uuid(15)],
      cycleId: CURRENT.id,
      now: 1,
    });
    expect(loaders.sprintIssues).toHaveBeenCalledWith(CURRENT.id);
    expect(loaders.projectIssues).not.toHaveBeenCalled();
    expect(inSprint.sprintIssueIds).toEqual([uuid(12), uuid(15)]);
    const mixed = await loadLivingMapData(loaders, {
      boardWorkItemIds: [uuid(15), uuid(40)],
      cycleId: CURRENT.id,
      now: 2,
    });
    expect(loaders.projectIssues).toHaveBeenCalledTimes(1);
    expect([...mixed.issues.keys()]).toEqual([uuid(12), uuid(15), uuid(40)]);
    const plain = await loadLivingMapData(loaders, { boardWorkItemIds: [uuid(40)], cycleId: null, now: 3 });
    expect(loaders.sprintIssues).toHaveBeenCalledTimes(2);
    expect(plain.sprintIssueIds).toBeNull();
    expect(plain.issues.has(uuid(40))).toBe(true);
    loaders.projectIssues.mockRejectedValueOnce(new Error("offline"));
    const partial = await loadLivingMapData(loaders, {
      boardWorkItemIds: [uuid(15), uuid(40)],
      cycleId: CURRENT.id,
      now: 4,
    });
    expect(partial.sprintIssueIds).toEqual([uuid(12), uuid(15)]);
  });

  it("shows the links of the cards that are on the board, on any v2 board", async () => {
    const frame = serializePpmCanvasNode(
      createPpmSprintFrameNode({ authorId: USER, cycleId: CURRENT.id, now: NOW, title: "Спринт 3" })
    );
    const loaders = {
      cycle: async () => CURRENT,
      modules: async () => MODULES,
      projectIssues: async () => [],
      pullRequests: async () => [],
      sprintIssues: async () => [issue(12), issue(15, [], { issue_relation: [relation(12, "blocked_by")] })],
    };
    const data = await loadLivingMapData(loaders, {
      boardWorkItemIds: [uuid(12), uuid(15)],
      cycleId: CURRENT.id,
      now: 1,
    });
    const view = computeLivingMapView({
      cards: [
        { binding: workItemBinding(12, "shape:a"), shapeId: "shape:a" },
        { binding: workItemBinding(15, "shape:b"), shapeId: "shape:b" },
      ],
      data,
      groups: mapGroupsOf([{ id: "shape:frame", node: frame, parentId: "page:page" }]),
      options: { assignees: [], priorities: [], states: STATES },
      projectId: PROJECT,
      projectIdentifier: "ROBOT",
      today: new Date(2026, 8, 26),
    });
    expect(view.relationEdges.map((edge) => [edge.kind, edge.fromShapeId, edge.toShapeId])).toEqual([
      ["blocks", "shape:a", "shape:b"],
    ]);
  });

  it("never writes the links: the layer only reads the context and draws inside tldraw's shapes layer", () => {
    const layer = read("living-map/task-relations-layer.tsx");
    has(layer, "editor.getContainer().querySelector<HTMLElement>(TLDRAW_SHAPES_LAYER_SELECTOR)");
    has(layer, "createPortal(");
    has(layer, 'aria-hidden="true"');
    has(layer, "buildSemanticEdgeGeometry(");
    has(layer, "editor.getZoomLevel() >= SEMANTIC_EDGE_CHIP_MIN_ZOOM");
    for (const forbidden of [
      "createSemanticEdge",
      "updateShapes",
      "createShapes",
      "saveBoard",
      "registerBindings",
      "getCamera",
    ])
      expect(layer, forbidden).not.toContain(forbidden);
    for (const file of ["living-map/task-relations.ts", "living-map/task-relations-layer.tsx"])
      expect(read(file), file).not.toContain("ppm-canvas.service");
    // Слой рисует в html-слое фигур закреплённого tldraw 3.15.6: при обновлении tldraw — сверить класс здесь.
    const nodeRequire = createRequire(import.meta.url);
    const editorEntry = nodeRequire.resolve("@tldraw/editor", { paths: [dirname(nodeRequire.resolve("tldraw"))] });
    const canvas = readFileSync(
      join(dirname(editorEntry), "lib/components/default-components/DefaultCanvas.js"),
      "utf8"
    );
    expect(TLDRAW_SHAPES_LAYER_SELECTOR).toBe(".tl-html-layer.tl-shapes");
    expect(canvas).toContain("tl-html-layer tl-shapes");
  });

  it("names the links as K5 does, in both languages", () => {
    expect(
      (["blocks", "depends_on", "relates_to", "implements"] as const).map((kind) =>
        getPpmTranslation("ru", TASK_LINK_LABEL_KEYS[kind])
      )
    ).toEqual(["Блокирует", "Зависит от", "Связано", "Реализует"]);
    expect(getPpmTranslation("ru", "canvas.map.relation_source")).toBe("из Задач");
    expect(getPpmTranslation("ru", "canvas.map.relation_hint")).toBe("Связь из Задач: изменяется в Задачах");
    expect(getPpmTranslation("en", "canvas.map.relation_blocks")).toBe("Blocks");
  });
});
