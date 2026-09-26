// AF2.2 C2: метки «изменено» / «добавлено» на карточках — по непросмотренному с личной отметки, пропадают после
// «Отметить просмотренным», без подписок на камеру; только облик v2 (CSS под грамматикой v2).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPpmCanvasNode, createPpmWorkItemRefNode, serializePpmCanvasNode } from "@ppm/canvas";
import {
  applySeen,
  buildBoardChangeIndex,
  changeMarkForShape,
  INITIAL_BOARD_CHANGES_STATE,
  mergeLoadedChanges,
  workItemIdOfNode,
} from "@/components/ppm-canvas/living-map/changes-model";
import type { TPpmBoardChange } from "@/services/ppm-canvas-changes.service";

const ME = "55555555-5555-4555-8555-555555555555";
const TASK = "77777777-7777-4777-8777-777777777777";
const BINDING = "99999999-9999-4999-8999-999999999999";
const dir = new URL("../../core/components/ppm-canvas/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
const shapeSource = read("shape.tsx");
const chipSource = read("living-map/change-chips.tsx");
const css = read("living-map/living-map.css");

const taskNode = serializePpmCanvasNode(
  createPpmWorkItemRefNode({
    authorId: ME,
    binding: { binding_id: BINDING, entity_type: "work_item", entity_id: TASK, source_version: null },
  })
);
const noteNode = serializePpmCanvasNode(createPpmCanvasNode({ authorId: ME, kind: "note", title: "work_item_ref" }));

function change(overrides: Partial<TPpmBoardChange> & Pick<TPpmBoardChange, "id" | "kind">): TPpmBoardChange {
  return {
    actor: null,
    detail: {},
    entity: { type: "work_item", id: TASK, identifier: "ROBOT-15" },
    occurred_at: new Date(2026, 8, 22, 12).toISOString(),
    shape_ids: [],
    ...overrides,
  };
}

function ruleBody(source: string, selector: string): string | undefined {
  const flat = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
  return [...flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, prelude]) =>
    prelude
      .split(",")
      .map((item) => item.trim())
      .includes(selector)
  )?.[2];
}

describe("marks «изменено» / «добавлено» (AF2.2 C2)", () => {
  it("finds the task of a live card; other cards have none", () => {
    expect(workItemIdOfNode(taskNode)).toBe(TASK);
    expect(workItemIdOfNode(noteNode)).toBeNull();
    expect(workItemIdOfNode("{broken")).toBeNull();
  });

  it("marks a card by its shape or by its task, «added» first", () => {
    const index = buildBoardChangeIndex([
      change({ id: "1", kind: "work_item.due" }),
      change({ id: "2", kind: "board.node.added", entity: { type: "node", id: "n" }, shape_ids: ["shape:note"] }),
    ]);
    expect(changeMarkForShape(index, "shape:note", null)).toBe("added");
    expect(changeMarkForShape(index, "shape:task-added-later", TASK)).toBe("changed");
    expect(changeMarkForShape(index, "shape:other", null)).toBeUndefined();
    // F's empty index (no provider, v1) has no byWorkItemId at all.
    expect(changeMarkForShape({ byShapeId: new Map() }, "shape:task", TASK)).toBeUndefined();
  });

  it("lasts until «Отметить просмотренным», then disappears", () => {
    const state = mergeLoadedChanges(INITIAL_BOARD_CHANGES_STATE, {
      period: null,
      seenAt: null,
      unseen: {
        items: [change({ id: "1", kind: "work_item.state", shape_ids: ["shape:task"] })],
        since: "",
        truncated: false,
      },
    });
    const before = buildBoardChangeIndex(state.unseen?.items ?? []);
    expect(changeMarkForShape(before, "shape:task", TASK)).toBe("changed");
    const after = buildBoardChangeIndex(applySeen(state, new Date(2026, 8, 26).toISOString()).unseen?.items ?? []);
    expect(changeMarkForShape(after, "shape:task", TASK)).toBeUndefined();
  });

  it("is drawn next to every PPM card from the shape util, outside the clipped card", () => {
    expect(shapeSource).toMatch(
      /override component\(shape: TPpmCanvasShape\) \{\s*return \(\s*<>\s*<PpmCanvasNodeCard shape=\{shape\} \/>\s*\{\/\* ── AF2\.2 C: [^\n]*── \*\/\}\s*<PpmChangeChip shape=\{shape\} \/>\s*\{\/\* ── \/AF2\.2 C ── \*\/\}\s*<\/>/
    );
    expect(shapeSource).toContain('import { PpmChangeChip } from "./living-map/change-chips";');
  });

  it("does not follow the camera: context only, the node parsed once per change of props.node", () => {
    expect(chipSource).not.toMatch(/\buse(?:Value|Editor|QuickReactor)\(/);
    expect(chipSource).toContain("useMemo(() => workItemIdOfNode(shape.props.node), [shape.props.node])");
    expect(chipSource).toContain(
      "const mark = grammarV2 ? changeMarkForShape(changes, shape.id, workItemId) : undefined;"
    );
  });

  it("sits on the top border, never takes clicks, and exists only under the v2 look", () => {
    const chip =
      ruleBody(css, ':where(html[data-ppm-design="v2"]) [data-ppm-canvas-grammar="v2"] .ppm-change-chip') ?? "";
    for (const declaration of ["position: absolute;", "top: -0.625rem;", "pointer-events: none;"])
      expect(chip).toContain(declaration);
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
    const selectors = [...flat.matchAll(/([^{}]+)\{/g)]
      .map((match) => match[1].trim())
      .filter((prelude) => !prelude.startsWith("@"))
      .flatMap((prelude) => prelude.split(",").map((selector) => selector.trim()));
    for (const selector of selectors.filter((item) => /ppm-change/.test(item)))
      expect(selector).toMatch(/^:where\(html\[data-ppm-design="v2"\]\) \[data-ppm-canvas-grammar="v2"\]/);
  });
});
