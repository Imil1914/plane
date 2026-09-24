import type { TPpmCanvasBoard } from "@ppm/canvas";

export const MAX_OPEN_CANVAS_BOARDS = 8;

export type TPpmCanvasBoardTabScope = {
  authorId: string;
  projectId: string;
  workspaceId: string;
};

export type TPpmCanvasBoardTabState = { activeBoardId: string; openBoardIds: string[] };

export function canvasBoardTabsKey(scope: TPpmCanvasBoardTabScope): string {
  return ["ppm", "canvas", "board-tabs", "v1", scope.workspaceId, scope.projectId, scope.authorId]
    .map(encodeURIComponent)
    .join(":");
}

export function readCanvasBoardTabs(
  storage: Pick<Storage, "getItem" | "removeItem"> | undefined,
  scope: TPpmCanvasBoardTabScope,
  validBoardIds: ReadonlySet<string>,
  defaultBoardId: string
): TPpmCanvasBoardTabState {
  const fallback = { activeBoardId: defaultBoardId, openBoardIds: [defaultBoardId] };
  if (!storage) return fallback;
  const key = canvasBoardTabsKey(scope);
  try {
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      !("openBoardIds" in value) ||
      !Array.isArray(value.openBoardIds) ||
      !("activeBoardId" in value) ||
      typeof value.activeBoardId !== "string" ||
      value.openBoardIds.some((id) => typeof id !== "string")
    ) {
      storage.removeItem(key);
      return fallback;
    }
    const openBoardIds = [...new Set<string>(value.openBoardIds)]
      .filter((id) => validBoardIds.has(id))
      .slice(0, MAX_OPEN_CANVAS_BOARDS);
    if (openBoardIds.length === 0) return fallback;
    return {
      activeBoardId: openBoardIds.includes(value.activeBoardId) ? value.activeBoardId : openBoardIds[0],
      openBoardIds,
    };
  } catch {
    // Private browsing or disabled storage must not prevent opening the board.
    return fallback;
  }
}

export function writeCanvasBoardTabs(
  storage: Pick<Storage, "setItem"> | undefined,
  scope: TPpmCanvasBoardTabScope,
  state: TPpmCanvasBoardTabState
): boolean {
  if (!storage || !state.openBoardIds.includes(state.activeBoardId)) return false;
  try {
    storage.setItem(
      canvasBoardTabsKey(scope),
      JSON.stringify({ activeBoardId: state.activeBoardId, openBoardIds: state.openBoardIds })
    );
    return true;
  } catch {
    return false;
  }
}

export type TPpmCanvasCommandItem<TCommand extends string = string> = {
  id: string;
  label: string;
  keywords: string[];
  command: TCommand;
};

export function openBoardTab(openBoardIds: string[], boardId: string, limit = MAX_OPEN_CANVAS_BOARDS): string[] {
  if (openBoardIds.includes(boardId)) return openBoardIds;
  if (openBoardIds.length < limit) return [...openBoardIds, boardId];
  return openBoardIds;
}

export function closeBoardTab(openBoardIds: string[], boardId: string, activeBoardId: string) {
  if (openBoardIds.length <= 1) return { activeBoardId, openBoardIds };
  const closingIndex = openBoardIds.indexOf(boardId);
  const nextOpenBoardIds = openBoardIds.filter((id) => id !== boardId);
  if (boardId !== activeBoardId) return { activeBoardId, openBoardIds: nextOpenBoardIds };
  const fallbackIndex = Math.min(Math.max(closingIndex, 0), nextOpenBoardIds.length - 1);
  return { activeBoardId: nextOpenBoardIds[fallbackIndex], openBoardIds: nextOpenBoardIds };
}

export function moveBoard(boards: TPpmCanvasBoard[], boardId: string, direction: -1 | 1): TPpmCanvasBoard[] {
  // oxlint-disable-next-line unicorn/no-array-sort -- filter returns a fresh array.
  const activeBoards = boards.filter((board) => board.status === "active").sort(compareBoards);
  // oxlint-disable-next-line unicorn/no-array-sort -- filter returns a fresh array.
  const archivedBoards = boards.filter((board) => board.status === "archived").sort(compareBoards);
  const index = activeBoards.findIndex((board) => board.board_id === boardId);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= activeBoards.length) return boards;
  const next = [...activeBoards];
  [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
  return [...next.map((board, position) => Object.assign({}, board, { position })), ...archivedBoards];
}

export function filterCanvasCommands<TCommand extends string>(
  commands: TPpmCanvasCommandItem<TCommand>[],
  query: string
) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return commands;
  return commands.filter((item) =>
    [item.label, ...item.keywords].some((value) => value.toLocaleLowerCase().includes(normalized))
  );
}

function compareBoards(first: TPpmCanvasBoard, second: TPpmCanvasBoard) {
  return first.position - second.position || first.created_at.localeCompare(second.created_at);
}
