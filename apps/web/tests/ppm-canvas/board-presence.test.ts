import { describe, expect, it } from "vitest";
import {
  buildPpmCanvasPresenceUrl,
  reduceBoardChange,
  reduceKnownBoardVersion,
  reducePresenceCursors,
  reducePresenceParticipants,
  resolveBoardChangeAction,
  resolveBoardSaveCompletion,
  type TPpmPresenceParticipant,
  uniquePresenceUsers,
} from "@/components/ppm-canvas/board-presence";

const owner: TPpmPresenceParticipant = {
  access: "edit",
  avatar_url: "",
  connection_id: "owner-one",
  display_name: "Руководитель проекта",
  joined_at: "2026-09-22T08:00:00.000Z",
  user_id: "owner",
};

describe("Canvas board presence", () => {
  it("builds a cookie-authenticated websocket URL on the API host", () => {
    expect(
      buildPpmCanvasPresenceUrl({
        apiBaseUrl: "https://api.ppm.test/base?ignored=1",
        boardId: "board",
        pageOrigin: "https://ppm.test",
        projectId: "project",
        workspaceId: "workspace",
      })
    ).toBe("wss://api.ppm.test/ws/ppm/v1/workspaces/workspace/projects/project/canvas/boards/board/presence/");
  });

  it("adds, updates and removes only the addressed connection", () => {
    const ready = reducePresenceParticipants({}, { type: "presence.ready", board_version: 0, self: owner });
    const member = {
      ...owner,
      connection_id: "member-one",
      display_name: "Участник",
      user_id: "member",
    };
    const joined = reducePresenceParticipants(ready, { type: "presence.joined", participant: member });
    const left = reducePresenceParticipants(joined, {
      type: "presence.left",
      connection_id: owner.connection_id,
      user_id: owner.user_id,
    });

    expect(Object.keys(joined)).toEqual(["owner-one", "member-one"]);
    expect(left).toEqual({ "member-one": member });
  });

  it("deduplicates two browser tabs of the same participant", () => {
    const secondTab = {
      ...owner,
      connection_id: "owner-two",
      joined_at: "2026-09-22T08:01:00.000Z",
    };

    expect(uniquePresenceUsers({ [owner.connection_id]: owner, [secondTab.connection_id]: secondTab })).toEqual([
      owner,
    ]);
  });

  it("tracks a remote cursor by connection and removes it when that connection leaves", () => {
    const moved = reducePresenceCursors(
      {},
      {
        type: "presence.cursor",
        connection_id: "member-one",
        cursor: { pointer_down: true, x: 120.5, y: -42 },
        display_name: "Участник",
        user_id: "member",
      },
      1234
    );
    const left = reducePresenceCursors(moved, {
      type: "presence.left",
      connection_id: "member-one",
      user_id: "member",
    });

    expect(moved["member-one"]).toEqual({
      connection_id: "member-one",
      display_name: "Участник",
      pointer_down: true,
      updated_at: 1234,
      user_id: "member",
      x: 120.5,
      y: -42,
    });
    expect(left).toEqual({});
  });

  it("hides cursors from another tab of the current user", () => {
    const unchanged = reducePresenceCursors(
      {},
      {
        type: "presence.cursor",
        connection_id: "owner-two",
        cursor: { pointer_down: false, x: 10, y: 20 },
        display_name: owner.display_name,
        user_id: owner.user_id,
      },
      1234,
      owner.user_id
    );

    expect(unchanged).toEqual({});
  });

  it("keeps only the newest board change notification", () => {
    const newest = reduceBoardChange(undefined, {
      type: "canvas.board.changed",
      board_id: "board",
      client_operation_id: "operation-two",
      content_hash: "b".repeat(64),
      saved_at: "2026-09-22T12:01:00.000Z",
      saved_by: "member",
      version: 2,
    });
    const stale = reduceBoardChange(newest, {
      type: "canvas.board.changed",
      board_id: "board",
      client_operation_id: "operation-one",
      content_hash: "a".repeat(64),
      saved_at: "2026-09-22T12:00:00.000Z",
      saved_by: "owner",
      version: 1,
    });

    expect(stale).toEqual(newest);
  });

  it("reconciles a missed board version on reconnect without rolling back a newer event", () => {
    const initial = reduceKnownBoardVersion(
      undefined,
      { type: "presence.ready", board_version: 2, self: owner },
      "board"
    );
    const newer = reduceKnownBoardVersion(
      initial,
      {
        type: "canvas.board.changed",
        board_id: "board",
        client_operation_id: "remote-operation",
        content_hash: "a".repeat(64),
        saved_at: "2026-09-22T12:00:00.000Z",
        saved_by: "member",
        version: 4,
      },
      "board"
    );
    const staleReconnect = reduceKnownBoardVersion(
      newer,
      { type: "presence.ready", board_version: 3, self: owner },
      "board"
    );
    const otherBoard = reduceKnownBoardVersion(
      staleReconnect,
      {
        type: "canvas.board.changed",
        board_id: "other-board",
        client_operation_id: "other-operation",
        content_hash: "b".repeat(64),
        saved_at: "2026-09-22T12:01:00.000Z",
        saved_by: "member",
        version: 9,
      },
      "board"
    );

    expect(initial).toEqual({ board_id: "board", version: 2 });
    expect(newer).toEqual({ board_id: "board", version: 4 });
    expect(staleReconnect).toBe(newer);
    expect(otherBoard).toBe(newer);
    expect(reduceKnownBoardVersion(newer, { type: "presence.ready", board_version: 5, self: owner }, "board")).toEqual({
      board_id: "board",
      version: 5,
    });
  });

  it("reloads only a clean remote version and never overwrites local changes", () => {
    const change = {
      board_id: "board",
      client_operation_id: "remote-operation",
      content_hash: "b".repeat(64),
      saved_at: "2026-09-22T12:01:00.000Z",
      saved_by: "member",
      version: 2,
    };

    expect(
      resolveBoardChangeAction({ change, currentVersion: 1, hasLocalChanges: false, pendingOperationId: undefined })
    ).toBe("reload");
    expect(
      resolveBoardChangeAction({ change, currentVersion: 1, hasLocalChanges: true, pendingOperationId: undefined })
    ).toBe("conflict");
    expect(
      resolveBoardChangeAction({
        change,
        currentVersion: 1,
        hasLocalChanges: true,
        pendingOperationId: "remote-operation",
      })
    ).toBe("ignore");
    expect(
      resolveBoardChangeAction({ change: { ...change, version: 1 }, currentVersion: 1, hasLocalChanges: false })
    ).toBe("ignore");
  });

  it("keeps a remote conflict visible when an in-flight local save finishes later", () => {
    expect(resolveBoardSaveCompletion(true, false)).toBe("conflict");
    expect(resolveBoardSaveCompletion(true, true)).toBe("conflict");
    expect(resolveBoardSaveCompletion(false, true)).toBe("save_again");
    expect(resolveBoardSaveCompletion(false, false)).toBe("saved");
  });
});
