import { describe, expect, it } from "vitest";
import {
  createPpmCanvasNode,
  getPpmCanvasPersistenceKey,
  isPpmCanvasEnabled,
  parseAndMigratePpmCanvasNode,
  parseSerializedPpmCanvasNode,
  PPM_CANVAS_NODE_REGISTRY,
  ppmCanvasErrorResponseSchema,
  ppmCanvasReadResponseSchema,
  ppmCanvasSaveResponseSchema,
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

describe("PPM Canvas HTTP contract", () => {
  const canvasId = "9ccca22c-1f55-4aed-873a-cf9a2f48ce07";
  const workspaceId = "cb25e219-d0b2-491c-ad24-3430b1a2c6d3";
  const projectId = "af7495ab-f952-4a89-9a24-6498d236584e";
  const userId = "8e3389db-299c-4861-89d3-1003d8e36105";

  it("accepts an empty first-open response", () => {
    expect(
      ppmCanvasReadResponseSchema.parse({
        canvas_id: canvasId,
        workspace_id: workspaceId,
        project_id: projectId,
        name: "Мозг проекта",
        schema_version: 1,
        version: 0,
        snapshot: null,
        snapshot_status: "empty",
        content_hash: null,
        saved_at: null,
        saved_by: null,
        access: "edit",
      }).snapshot_status
    ).toBe("empty");
  });

  it("rejects a ready response without a snapshot", () => {
    expect(
      ppmCanvasReadResponseSchema.safeParse({
        canvas_id: canvasId,
        workspace_id: workspaceId,
        project_id: projectId,
        name: "Мозг проекта",
        schema_version: 1,
        version: 1,
        snapshot: null,
        snapshot_status: "ready",
        content_hash: "a".repeat(64),
        saved_at: "2026-09-13T08:00:00.000Z",
        saved_by: userId,
        access: "read",
      }).success
    ).toBe(false);
  });

  it("validates save and error envelopes", () => {
    expect(
      ppmCanvasSaveResponseSchema.parse({
        canvas_id: canvasId,
        version: 1,
        content_hash: "b".repeat(64),
        saved_at: "2026-09-13T08:00:00.000Z",
        saved_by: userId,
        request_id: "f34502e2-ef58-475f-939f-6f835d7b94ec",
        idempotent_replay: false,
      }).version
    ).toBe(1);
    expect(
      ppmCanvasErrorResponseSchema.parse({
        error: {
          code: "CANVAS_VERSION_CONFLICT",
          message: "conflict",
          request_id: "263d0111-03e4-4f7f-a655-b9b42e0a90fa",
          details: { current_version: 2 },
        },
      }).error.code
    ).toBe("CANVAS_VERSION_CONFLICT");
  });
});
