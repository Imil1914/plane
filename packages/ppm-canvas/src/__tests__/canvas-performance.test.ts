import { describe, expect, it } from "vitest";
import {
  createPpmCanvasNode,
  parseSerializedPpmCanvasNode,
  serializePpmCanvasNode,
  type TPpmCanvasOwnedNodeKind,
} from "../index";

const NATIVE_KINDS: TPpmCanvasOwnedNodeKind[] = [
  "note",
  "document",
  "checklist",
  "table",
  "code",
  "group",
  "frame",
  "board_link",
];
const BOARD_ID = "ec4d3217-4d33-4628-b4e9-3c7fd63d2bb0";

describe("PPM Canvas 300-shape baseline", () => {
  it("creates, serializes, and restores 300 mixed browser-safe nodes within the unit budget", () => {
    const startedAt = performance.now();
    const serialized = Array.from({ length: 300 }, (_, index) => {
      const kind = NATIVE_KINDS[index % NATIVE_KINDS.length] ?? "note";
      return serializePpmCanvasNode(
        createPpmCanvasNode({
          authorId: "performance-user",
          kind,
          now: "2026-09-19T00:00:00.000Z",
          ...(kind === "board_link" ? { targetBoardId: BOARD_ID } : {}),
          title: `Node ${index}`,
        })
      );
    });
    const restored = serialized.map(parseSerializedPpmCanvasNode);
    const elapsed = performance.now() - startedAt;

    expect(restored).toHaveLength(300);
    expect(restored.every((result) => result.status === "valid")).toBe(true);
    expect(elapsed).toBeLessThan(1_000);
  });
});
