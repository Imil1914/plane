import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TPpmCanvasBoard } from "@ppm/canvas";
import {
  canvasBoardTabsKey,
  closeBoardTab,
  filterCanvasCommands,
  MAX_OPEN_CANVAS_BOARDS,
  moveBoard,
  openBoardTab,
  openLinkedBoardTabs,
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

// AF2.2, итоговое ревью M-5: ссылка ?board= («На карте» в задаче) на доску, которой не хватает вкладки (открыто 8), —
// не тихий переход на первую вкладку: вкладки и активная доска прежние, рабочее пространство сообщает предел.
describe("Canvas board link (?board=) and the tab limit", () => {
  const valid = new Set(["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9"]);
  const saved = { activeBoardId: "b2", openBoardIds: ["b1", "b2"] };
  const eight = ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8"];

  it("opens the linked board in a new active tab while a tab is free", () => {
    expect(
      openLinkedBoardTabs({
        currentActiveBoardId: undefined,
        currentOpenBoardIds: [],
        linkedBoardId: "b5",
        savedTabs: saved,
        validBoardIds: valid,
      })
    ).toEqual({ activeBoardId: "b5", openBoardIds: ["b1", "b2", "b5"], tabLimit: false });
    // Уже открытая доска ссылки — та же вкладка, новой нет.
    expect(
      openLinkedBoardTabs({
        currentActiveBoardId: "b3",
        currentOpenBoardIds: eight,
        linkedBoardId: "b7",
        savedTabs: saved,
        validBoardIds: valid,
      })
    ).toEqual({ activeBoardId: "b7", openBoardIds: eight, tabLimit: false });
  });

  it("stays on the current tab and reports the limit when every tab is taken", () => {
    expect(eight).toHaveLength(MAX_OPEN_CANVAS_BOARDS);
    expect(
      openLinkedBoardTabs({
        currentActiveBoardId: "b3",
        currentOpenBoardIds: eight,
        linkedBoardId: "b9",
        savedTabs: saved,
        validBoardIds: valid,
      })
    ).toEqual({ activeBoardId: "b3", openBoardIds: eight, tabLimit: true });
    // Первая загрузка: восемь сохранённых вкладок — остаётся сохранённая активная.
    expect(
      openLinkedBoardTabs({
        currentActiveBoardId: undefined,
        currentOpenBoardIds: [],
        linkedBoardId: "b9",
        savedTabs: { activeBoardId: "b8", openBoardIds: eight },
        validBoardIds: valid,
      })
    ).toEqual({ activeBoardId: "b8", openBoardIds: eight, tabLimit: true });
  });

  it("restores the tabs as before without a link or with a link to a board that is not active", () => {
    const restored = { activeBoardId: "b2", openBoardIds: ["b1", "b2"], tabLimit: false };
    for (const linkedBoardId of [undefined, "archived"])
      expect(
        openLinkedBoardTabs({
          currentActiveBoardId: undefined,
          currentOpenBoardIds: [],
          linkedBoardId,
          savedTabs: saved,
          validBoardIds: valid,
        })
      ).toEqual(restored);
    // Уже открытые вкладки (повторная загрузка списка) важнее сохранённых; закрытая доска из них выпадает.
    expect(
      openLinkedBoardTabs({
        currentActiveBoardId: "gone",
        currentOpenBoardIds: ["b4", "gone", "b6"],
        linkedBoardId: undefined,
        savedTabs: saved,
        validBoardIds: valid,
      })
    ).toEqual({ activeBoardId: "b2", openBoardIds: ["b4", "b6"], tabLimit: false });
  });

  it("shows canvas.board_tab_limit the way the workspace reports the limit and drops ?shape= of that link", () => {
    const workspace = readFileSync(
      new URL("../../core/components/ppm-canvas/workspace.tsx", import.meta.url),
      "utf8"
    ).replace(/\s+/g, " ");
    expect(workspace).toContain("const tabs = openLinkedBoardTabs({");
    expect(workspace).toContain('if (tabs.tabLimit) { setActionError(ppmT("canvas.board_tab_limit"));');
    expect(workspace).toContain("url.searchParams.delete(PPM_CANVAS_SHAPE_PARAM);");
    expect(workspace).not.toContain("return linkedBoardId ? openBoardTab(valid, linkedBoardId) : valid;");
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
