// AF2.1 F1: palette colours, note format, code fields and the document (page_ref) card — all backward compatible:
// boards saved before AF2.1 open unchanged, unknown fields survive, the board schema version stays 2 (server-pinned).
import { describe, expect, it } from "vitest";
import {
  PPM_CANVAS_COLORS,
  PPM_CANVAS_LEGACY_COLOR_MAP,
  PPM_CANVAS_LEGACY_COLORS,
  PPM_CANVAS_SCHEMA_VERSION,
  createPpmCanvasNode,
  createPpmContentRefNode,
  duplicatePpmCanvasNode,
  normalizePpmCanvasColor,
  parseAndMigratePpmCanvasNode,
  serializePpmCanvasNode,
  updatePpmCanvasNode,
} from "../index";

const NOW = "2026-09-25T12:00:00.000Z";
const PAGE_BINDING = {
  binding_id: "7b0f5d0e-3f55-4a51-9c32-1f7f3d1a2b01",
  entity_type: "page" as const,
  entity_id: "2c1d8f41-6a0b-4d8e-8d0f-5b8f0e4f7a02",
  source_version: "2026-09-25T11:59:00Z",
};

function storedNote(extra: Record<string, unknown> = {}) {
  return {
    schema_version: 2,
    kind: "note",
    title: "Старая заметка",
    body: "a*b*c",
    author_id: "user-1",
    created_at: NOW,
    updated_at: NOW,
    visual: { color: "yellow", width: 320, height: 220 },
    ...extra,
  };
}

describe("AF2.1 canvas schema", () => {
  it("keeps the board schema version the server accepts", () => {
    expect(PPM_CANVAS_SCHEMA_VERSION).toBe(2);
  });

  it("publishes the PPM palette: neutral + 8 hues, and every legacy colour maps to itself", () => {
    expect(PPM_CANVAS_COLORS).toEqual([
      "neutral",
      "yellow",
      "orange",
      "terracotta",
      "pink",
      "violet",
      "blue",
      "cyan",
      "green",
    ]);
    for (const legacy of PPM_CANVAS_LEGACY_COLORS) {
      expect(PPM_CANVAS_LEGACY_COLOR_MAP[legacy]).toBe(legacy);
      expect(PPM_CANVAS_COLORS).toContain(legacy);
    }
  });

  it("reads a pre-AF2.1 note as valid plain text with its colour and unknown fields intact", () => {
    const result = parseAndMigratePpmCanvasNode(storedNote({ future_hint: { keep: true } }));
    expect(result.status).toBe("valid");
    if (result.status !== "valid" || result.node.kind !== "note") throw new Error("Expected a valid note.");
    expect(result.node.format).toBe("plain");
    expect(result.node.visual.color).toBe("yellow");
    expect(result.node).toMatchObject({ body: "a*b*c", future_hint: { keep: true } });
  });

  it("round-trips every palette colour and rejects a colour outside the palette", () => {
    for (const color of PPM_CANVAS_COLORS) {
      const result = parseAndMigratePpmCanvasNode(storedNote({ visual: { color, width: 320, height: 220 } }));
      expect(result.status, color).toBe("valid");
      if (result.status === "valid") expect(result.node.visual.color).toBe(color);
    }
    expect(parseAndMigratePpmCanvasNode(storedNote({ visual: { color: "red", width: 320, height: 220 } })).status).toBe(
      "corrupt"
    );
  });

  it("normalizes any stored colour to the palette", () => {
    expect(normalizePpmCanvasColor("pink", "neutral")).toBe("pink");
    expect(normalizePpmCanvasColor("red", "neutral")).toBe("neutral");
    expect(normalizePpmCanvasColor(undefined, "yellow")).toBe("yellow");
  });

  it("creates Markdown notes by default and plain notes on request, with an optional palette colour", () => {
    const markdown = createPpmCanvasNode({ authorId: "user-1", kind: "note", now: NOW, title: "Заметка" });
    const plain = createPpmCanvasNode({
      authorId: "user-1",
      color: "pink",
      kind: "note",
      noteFormat: "plain",
      now: NOW,
      title: "Заметка",
    });
    if (markdown.kind !== "note" || plain.kind !== "note") throw new Error("Expected notes.");
    expect(markdown.format).toBe("markdown");
    expect(plain.format).toBe("plain");
    expect(plain.visual.color).toBe("pink");
    expect(markdown.visual.color).toBe("yellow");
  });

  it("gives old code blocks the AF2.1 defaults and keeps new fields through an update", () => {
    const legacy = parseAndMigratePpmCanvasNode({
      schema_version: 2,
      kind: "code",
      title: "Код",
      code: "print(1)",
      language: "python",
      executable: false,
      author_id: "user-1",
      created_at: NOW,
      updated_at: NOW,
      visual: { color: "violet", width: 460, height: 340 },
    });
    if (legacy.status !== "valid" || legacy.node.kind !== "code") throw new Error("Expected a valid code block.");
    expect(legacy.node).toMatchObject({ language: "python", theme: "auto", locked: false, wrap: false });

    const created = createPpmCanvasNode({ authorId: "user-1", kind: "code", now: NOW, title: "Код" });
    if (created.kind !== "code") throw new Error("Expected code.");
    expect(created).toMatchObject({ language: "text", theme: "auto", locked: false, wrap: false, executable: false });
    const locked = updatePpmCanvasNode(created, { locked: true, theme: "dark", wrap: true }, NOW);
    expect(locked).toMatchObject({ locked: true, theme: "dark", wrap: true });
    const reread = parseAndMigratePpmCanvasNode(JSON.parse(serializePpmCanvasNode(locked)));
    expect(reread).toMatchObject({ status: "valid", node: { locked: true, theme: "dark", wrap: true } });
  });

  it("creates a document card from a page binding and refuses any other binding", () => {
    const card = createPpmContentRefNode({
      authorId: "user-1",
      binding: PAGE_BINDING,
      kind: "page_ref",
      now: NOW,
      sourceUrl: "/robot/projects/228/pages/2c1d8f41-6a0b-4d8e-8d0f-5b8f0e4f7a02",
      title: "Отчёт о калибровке",
    });
    expect(card).toMatchObject({
      schema_version: 2,
      kind: "page_ref",
      title: "Отчёт о калибровке",
      binding: PAGE_BINDING,
      visual: { color: "cyan", width: 360, height: 240 },
    });
    expect(parseAndMigratePpmCanvasNode(card).status).toBe("valid");
    expect(() =>
      createPpmContentRefNode({
        authorId: "user-1",
        binding: { ...PAGE_BINDING, entity_type: "vault_file" },
        kind: "page_ref",
        now: NOW,
        sourceUrl: "/x",
        title: "Не документ",
      })
    ).toThrow("A document card requires a page binding.");
  });

  it("makes a page binding a document card even when the caller guessed «reference» (editor.tsx contentNodeKind)", () => {
    const card = createPpmContentRefNode({
      authorId: "user-1",
      binding: PAGE_BINDING,
      extension: ".page",
      kind: "reference",
      now: NOW,
      sourceUrl: "/robot/projects/228/pages/2c1d8f41-6a0b-4d8e-8d0f-5b8f0e4f7a02",
      title: "Отчёт о калибровке",
    });
    expect(card.kind).toBe("page_ref");
    expect(card).not.toHaveProperty("extension");
  });

  it("links checklist items to tasks, keeps unknown item fields and unlinks copies", () => {
    const result = parseAndMigratePpmCanvasNode({
      schema_version: 2,
      kind: "checklist",
      title: "Список",
      items: [
        { id: "a", text: "Замер", checked: false, work_item_id: "9b2f4c1e-0d7a-4b8e-9f10-2a3b4c5d6e7f", hint: "keep" },
        { id: "b", text: "Отчёт", checked: true },
      ],
      author_id: "user-1",
      created_at: NOW,
      updated_at: NOW,
      visual: { color: "green", width: 320, height: 220 },
    });
    if (result.status !== "valid" || result.node.kind !== "checklist") throw new Error("Expected a valid checklist.");
    expect(result.node.items[0]).toMatchObject({ work_item_id: "9b2f4c1e-0d7a-4b8e-9f10-2a3b4c5d6e7f", hint: "keep" });
    expect(result.node.items[1]).not.toHaveProperty("work_item_id");
    const copy = duplicatePpmCanvasNode(result.node, "user-2", NOW);
    expect(copy.items[0]).not.toHaveProperty("work_item_id");
    expect(copy.items[0]).toMatchObject({ text: "Замер", hint: "keep" });
    expect(copy.items[0]?.id).not.toBe("a");
    expect(
      parseAndMigratePpmCanvasNode({
        ...result.node,
        items: [{ id: "c", text: "x", checked: false, work_item_id: "not-a-uuid" }],
      }).status
    ).toBe("corrupt");
  });

  it("still creates media cards through the same factory", () => {
    const image = createPpmContentRefNode({
      authorId: "user-1",
      binding: { ...PAGE_BINDING, entity_type: "vault_file" },
      extension: "png",
      kind: "image",
      now: NOW,
      sourceUrl: "/file",
      title: "Вставка.png",
    });
    expect(image).toMatchObject({ kind: "image", extension: "png", alt: "Вставка.png" });
  });
});
