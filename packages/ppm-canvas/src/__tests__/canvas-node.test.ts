import { describe, expect, it } from "vitest";
import {
  createPpmCanvasNode,
  getPpmCanvasPersistenceKey,
  isPpmCanvasEnabled,
  parseAndMigratePpmCanvasNode,
  parseSerializedPpmCanvasNode,
  PPM_CANVAS_NODE_REGISTRY,
  updatePpmCanvasNode,
} from "../index";

const NOW = "2026-09-13T00:00:00.000Z";

describe("PPM Canvas node schema", () => {
  it("creates a versioned note with browser-safe data", () => {
    const note = createPpmCanvasNode({ authorId: "user-1", kind: "note", now: NOW, title: "Новая заметка" });

    expect(note).toMatchObject({
      schema_version: 1,
      kind: "note",
      title: "Новая заметка",
      author_id: "user-1",
      created_at: NOW,
      updated_at: NOW,
      visual: {
        color: PPM_CANVAS_NODE_REGISTRY.note.defaultColor,
        height: PPM_CANVAS_NODE_REGISTRY.note.defaultHeight,
        width: PPM_CANVAS_NODE_REGISTRY.note.defaultWidth,
      },
    });
  });

  it("migrates a legacy note and preserves unknown fields", () => {
    const result = parseAndMigratePpmCanvasNode({
      kind: "note",
      title: "Legacy",
      body: "Text",
      color: "green",
      width: 400,
      height: 240,
      future_hint: { keep: true },
    });

    expect(result.status).toBe("migrated");
    if (result.status !== "migrated") return;
    expect(result.node.visual).toMatchObject({ color: "green", width: 400, height: 240 });
    expect(result.node).toMatchObject({ future_hint: { keep: true } });
  });

  it("returns stable fallbacks for unknown and corrupt nodes", () => {
    expect(parseAndMigratePpmCanvasNode({ schema_version: 1, kind: "future-node" })).toMatchObject({
      status: "unknown",
      kind: "future-node",
    });
    expect(parseSerializedPpmCanvasNode("{not-json")).toMatchObject({ status: "corrupt" });
    expect(parseAndMigratePpmCanvasNode({ schema_version: 1, kind: "note", title: 7 })).toMatchObject({
      status: "corrupt",
    });
  });

  it("updates editable content without changing authorship", () => {
    const note = createPpmCanvasNode({ authorId: "user-1", kind: "note", now: NOW, title: "Before" });
    const updated = updatePpmCanvasNode(note, { body: "Markdown", title: "After" }, "2026-09-13T00:01:00.000Z");

    expect(updated).toMatchObject({
      author_id: "user-1",
      body: "Markdown",
      title: "After",
      created_at: NOW,
      updated_at: "2026-09-13T00:01:00.000Z",
    });
  });
});

describe("PPM Canvas project boundary", () => {
  it("isolates temporary local stores by workspace, project, and user", () => {
    const first = getPpmCanvasPersistenceKey("workspace-a", "project-a", "user-a");

    expect(first).not.toBe(getPpmCanvasPersistenceKey("workspace-b", "project-a", "user-a"));
    expect(first).not.toBe(getPpmCanvasPersistenceKey("workspace-a", "project-b", "user-a"));
    expect(first).not.toBe(getPpmCanvasPersistenceKey("workspace-a", "project-a", "user-b"));
  });

  it("requires both the shell and Canvas feature flag", () => {
    expect(isPpmCanvasEnabled(undefined, true)).toBe(true);
    expect(isPpmCanvasEnabled("0", true)).toBe(false);
    expect(isPpmCanvasEnabled("1", false)).toBe(false);
  });
});
