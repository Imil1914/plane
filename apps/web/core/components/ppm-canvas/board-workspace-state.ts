import { resolvePpmLocale } from "@ppm/brand";
import type { TPpmCanvasBoard, TPpmCanvasSyncStatus } from "@ppm/canvas";

export const MAX_OPEN_CANVAS_BOARDS = 8;

// Below this width the rail starts (and snaps back to) collapsed so it does not eat canvas space
// on laptop-size viewports. Independent of canvas.css's 980px overlay breakpoint, which still
// governs when an expanded rail floats over the canvas instead of taking its own column.
export const CANVAS_RAIL_COLLAPSE_QUERY = "(max-width: 1279px)";

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

// Conflict, error and corrupt states (and any pending draft recovery) need a user decision,
// so they are shown as a banner with actions instead of the quiet footer status.
export function isBlockingCanvasStatus(status: TPpmCanvasSyncStatus | undefined, recoveryMode: boolean): boolean {
  return recoveryMode || status === "conflict" || status === "error" || status === "corrupt";
}

// The footer only reports the active board; background tabs keep a dot while they save or need attention.
export function shouldShowTabSyncDot(status: TPpmCanvasSyncStatus | undefined): boolean {
  return status === "saving" || status === "error" || status === "conflict" || status === "corrupt";
}

// Right side of the footer: the access role, unless the status label on the left already says "read-only".
export function footerRoleLabelKey(
  canEdit: boolean,
  statusKey: string
): "canvas.shared_badge" | "canvas.read_only_title" | null {
  if (canEdit) return "canvas.shared_badge";
  return statusKey === "canvas.read_only_title" ? null : "canvas.read_only_title";
}

// Hint for the canvas command palette; Apple keyboards show ⌘, everyone else presses Ctrl.
export function formatCanvasCommandShortcut(platform: string): string {
  return /mac|iphone|ipad/i.test(platform) ? "⌘K" : "Ctrl K";
}

// ⌘K opens the canvas palette only while focus is on the page body or inside the canvas workspace.
// Anywhere else (Plane's top bar, Power-K, Plane modals) the shortcut is left to Plane's own palette.
export function shouldCanvasOwnCommandShortcut(activeElement: Element | null, workspace: Element | null): boolean {
  if (!activeElement || activeElement.tagName === "BODY") return true;
  return Boolean(workspace?.contains(activeElement));
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

// UX1.1: commands a read-only viewer may run. v2 adds zoom reset and the read-only semantic links list (R12).
const READ_ONLY_COMMANDS_V1: readonly string[] = ["select", "fit-view", "zoom-in", "zoom-out"];
const READ_ONLY_COMMANDS_V2: readonly string[] = [...READ_ONLY_COMMANDS_V1, "zoom-reset", "semantic-edges"];

export function isCanvasCommandAllowedReadOnly(command: string, designV2: boolean): boolean {
  return (designV2 ? READ_ONLY_COMMANDS_V2 : READ_ONLY_COMMANDS_V1).includes(command);
}

export type TPpmCanvasStatusParts = {
  sheet: { index: number; total: number } | null;
  time: { iso: string; label: string } | null;
  role: "canvas.read_only_title" | null;
};

// UX1.1 status line «Лист 2 из 3 · Все изменения сохранены · 12:41». No version (R5); the saved label itself stays
// a separate element so the exact e2e text «Все изменения сохранены» keeps matching.
export function formatCanvasStatusParts(input: {
  activeBoardIds: readonly string[];
  boardId: string;
  locale: string;
  now?: Date;
  roleKey: "canvas.shared_badge" | "canvas.read_only_title" | null;
  savedAt: string | null | undefined;
  statusKey: string;
}): TPpmCanvasStatusParts {
  const position = input.activeBoardIds.indexOf(input.boardId);
  const total = input.activeBoardIds.length;
  const label =
    input.statusKey === "canvas.sync_saved" && input.savedAt
      ? formatCanvasSavedTime(input.savedAt, input.locale, input.now)
      : null;
  return {
    sheet: position >= 0 && total > 1 ? { index: position + 1, total } : null,
    time: label && input.savedAt ? { iso: input.savedAt, label } : null,
    role: input.roleKey === "canvas.read_only_title" ? input.roleKey : null,
  };
}

// The time follows the UI language (ru* → ru, anything else → en), like the rest of the canvas and «Задачи».
export function formatCanvasSavedTime(savedAt: string, locale: string, now: Date = new Date()): string | null {
  const date = new Date(savedAt);
  if (Number.isNaN(date.getTime())) return null;
  const sameDay =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return new Intl.DateTimeFormat(
    resolvePpmLocale(locale),
    sameDay
      ? { hour: "2-digit", minute: "2-digit" }
      : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }
  ).format(date);
}

// «100 %» with U+00A0: the number and the sign never wrap apart (the reset label canvas.zoom_reset_label matches).
export function formatCanvasZoom(zoom: number): string {
  return `${Math.round(zoom)}\u00a0%`;
}
