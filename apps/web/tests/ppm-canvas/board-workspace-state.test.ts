import { describe, expect, it } from "vitest";
import type { TPpmCanvasBoard } from "@ppm/canvas";
import {
  canvasBoardTabsKey,
  closeBoardTab,
  filterCanvasCommands,
  moveBoard,
  openBoardTab,
  readCanvasBoardTabs,
  writeCanvasBoardTabs,
} from "@/components/ppm-canvas/board-workspace-state";

const NOW = "2026-09-19T10:00:00.000Z";

function board(id: string, name: string, position: number): TPpmCanvasBoard {
  return {
    archived_at: null,
    board_id: id,
    created_at: NOW,
    created_by: "8e3389db-299c-4861-89d3-1003d8e36105",
    name,
    position,
    status: "active",
    updated_at: NOW,
    updated_by: "8e3389db-299c-4861-89d3-1003d8e36105",
    version: 0,
  };
}

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("Canvas board tabs", () => {
  const scope = { authorId: "owner", projectId: "project", workspaceId: "workspace" };

  it("keeps already-open tabs and activates a predictable neighbor when closing", () => {
    expect(openBoardTab(["one"], "one")).toEqual(["one"]);
    expect(openBoardTab(["one"], "two")).toEqual(["one", "two"]);
    expect(closeBoardTab(["one", "two", "three"], "two", "two")).toEqual({
      activeBoardId: "three",
      openBoardIds: ["one", "three"],
    });
  });

  it("never evicts an existing tab when the safe open-board limit is reached", () => {
    expect(openBoardTab(["one", "two"], "three", 2)).toEqual(["one", "two"]);
  });

  it("restores the active tab for the same user and prunes archived board IDs", () => {
    const local = storage();
    expect(writeCanvasBoardTabs(local, scope, { activeBoardId: "two", openBoardIds: ["one", "two"] })).toBe(true);
    expect(readCanvasBoardTabs(local, scope, new Set(["one", "two"]), "one")).toEqual({
      activeBoardId: "two",
      openBoardIds: ["one", "two"],
    });
    expect(readCanvasBoardTabs(local, scope, new Set(["one"]), "one")).toEqual({
      activeBoardId: "one",
      openBoardIds: ["one"],
    });
    expect(readCanvasBoardTabs(local, { ...scope, authorId: "member" }, new Set(["one", "two"]), "one")).toEqual({
      activeBoardId: "one",
      openBoardIds: ["one"],
    });
  });

  it("rejects malformed local tab state and falls back to the server default", () => {
    const local = storage();
    local.setItem(canvasBoardTabsKey(scope), '{"openBoardIds":["one"],"activeBoardId":1}');
    expect(readCanvasBoardTabs(local, scope, new Set(["one"]), "one")).toEqual({
      activeBoardId: "one",
      openBoardIds: ["one"],
    });
    expect(local.getItem(canvasBoardTabsKey(scope))).toBeNull();
  });

  it("reorders only active boards", () => {
    const first = board("one", "Главная", 0);
    const second = board("two", "Исследование", 1);
    const archived = { ...board("archive", "Старая", 2), archived_at: NOW, status: "archived" as const };

    expect(moveBoard([first, second, archived], "two", -1).map((item) => item.board_id)).toEqual([
      "two",
      "one",
      "archive",
    ]);
  });
});

describe("Canvas command palette", () => {
  const commands = [
    { command: "note", id: "note", keywords: ["заметка", "text"], label: "Добавить заметку" },
    { command: "fit", id: "fit", keywords: ["камера", "view"], label: "Показать всё" },
  ];

  it("finds commands by localized label and hidden keywords", () => {
    expect(filterCanvasCommands(commands, "замет").map((item) => item.id)).toEqual(["note"]);
    expect(filterCanvasCommands(commands, "view").map((item) => item.id)).toEqual(["fit"]);
    expect(filterCanvasCommands(commands, "")).toEqual(commands);
  });
});
