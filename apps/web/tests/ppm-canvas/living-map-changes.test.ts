// AF2.2 C1: «Что изменилось» — сервис S2/S3 (zod, по пунктам), период ленты и правило по умолчанию (R5), загрузка
// двух лент (непросмотренное и период панели), свёртка, индекс меток, переход к карточке; хук — только у активной
// вкладки (AF2.1 R19), опрос раз в 60 с при открытой панели (R8), запись — только «Отметить просмотренным».
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Editor } from "tldraw";
import { createPpmCanvasNode } from "@ppm/canvas";
import {
  applySeen,
  beginChangesLoad,
  buildBoardChangeIndex,
  changesDateBounds,
  changesLoadStatus,
  changesPeriodKey,
  changesSinceForMode,
  clampChangesDate,
  defaultChangesSince,
  failChangesLoad,
  findSprintCycleId,
  focusChangeShapes,
  groupBoardChanges,
  INITIAL_BOARD_CHANGES_STATE,
  loadBoardChanges,
  localDayStartIso,
  mergeLoadedChanges,
  PPM_CHANGES_DATE_DEBOUNCE_MS,
  PPM_CHANGES_POLL_MS,
  presentShapeKey,
  shouldRefreshOnReturn,
  unseenChangeEntries,
} from "@/components/ppm-canvas/living-map/changes-model";
import { PpmCanvasChangesService, type TPpmBoardChange } from "@/services/ppm-canvas-changes.service";
import { PpmCanvasServiceError } from "@/services/ppm-canvas.service";

const WS = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const BOARD = "44444444-4444-4444-8444-444444444444";
const ME = "55555555-5555-4555-8555-555555555555";
const DASHA = "66666666-6666-4666-8666-666666666666";
const TASK_15 = "77777777-7777-4777-8777-777777777777";
const CYCLE = "88888888-8888-4888-8888-888888888888";
const BASE = `/api/ppm/v1/workspaces/${WS}/projects/${PROJECT}/canvas/boards/${BOARD}/`;
const DAY = 86_400_000;

// Местное время: тесты не зависят от часового пояса машины.
const at = (day: number, hour = 12, minute = 0) => new Date(2026, 8, day, hour, minute).toISOString();
const NOW = new Date(2026, 8, 26, 12, 0).getTime();

function change(overrides: Partial<TPpmBoardChange> & Pick<TPpmBoardChange, "id" | "kind">): TPpmBoardChange {
  return {
    actor: { id: DASHA, display_name: "Даша П." },
    detail: {},
    entity: { type: "work_item", id: TASK_15, identifier: "ROBOT-15", title: "Сценарий сортировки" },
    occurred_at: at(22),
    shape_ids: [],
    ...overrides,
  };
}

describe("changes service (S2, S3)", () => {
  it("asks for the board feed since a moment, at most 200 events, and drops items it cannot read", async () => {
    const service = new PpmCanvasChangesService();
    const good = change({
      id: "a",
      kind: "work_item.state",
      detail: { field: "state", old: "Todo", new: "In Progress" },
    });
    const get = vi.spyOn(service, "get").mockResolvedValue({
      data: {
        since: at(19),
        until: at(26),
        items: [good, { ...good, id: "b", kind: "work_item.labels" }, { id: "c" }],
        truncated: false,
      },
    } as never);

    const response = await service.getChanges(WS, PROJECT, BOARD, at(19), 500);

    expect(get).toHaveBeenCalledWith(`${BASE}changes/`, { params: { since: at(19), limit: 200 } });
    expect(response.items.map((item) => item.id)).toEqual(["a"]);
    expect(response).toMatchObject({ since: at(19), truncated: false, until: at(26) });
  });

  it("reads and writes the personal checkpoint; an empty answer means «never viewed»", async () => {
    const service = new PpmCanvasChangesService();
    const get = vi.spyOn(service, "get").mockResolvedValue({ data: "" } as never);
    const put = vi.spyOn(service, "put").mockResolvedValue({ data: { seen_at: at(26), seen_version: 7 } } as never);

    await expect(service.getSeen(WS, PROJECT, BOARD)).resolves.toEqual({ seen_at: null, seen_version: null });
    await expect(service.markSeen(WS, PROJECT, BOARD)).resolves.toEqual({ seen_at: at(26), seen_version: 7 });
    expect(get).toHaveBeenCalledWith(`${BASE}me/`);
    expect(put).toHaveBeenCalledWith(`${BASE}me/seen/`, {});
  });

  it("turns a PPM error into PpmCanvasServiceError; 403/404 hide the feature, other failures offer a retry", async () => {
    const service = new PpmCanvasChangesService();
    const notFound = Object.assign(new Error("Request failed"), {
      isAxiosError: true,
      response: {
        status: 404,
        data: {
          error: {
            code: "CANVAS_BOARD_NOT_FOUND",
            message: "Board not found.",
            request_id: "99999999-9999-4999-8999-999999999999",
            details: {},
          },
        },
      },
    });
    vi.spyOn(service, "get").mockRejectedValue(notFound);

    const failure = await service.getSeen(WS, PROJECT, BOARD).catch((reason: unknown) => reason);

    expect(failure).toBeInstanceOf(PpmCanvasServiceError);
    expect(failure).toMatchObject({ code: "CANVAS_BOARD_NOT_FOUND", status: 404 });
    expect(changesLoadStatus(failure)).toBe("unavailable");
    expect(changesLoadStatus(new PpmCanvasServiceError("denied", { status: 403 }))).toBe("unavailable");
    expect(changesLoadStatus(new PpmCanvasServiceError("down", { status: 502 }))).toBe("error");
    expect(changesLoadStatus(new Error("offline"))).toBe("error");
  });
});

describe("period of the feed (R5)", () => {
  it("starts from the personal checkpoint, else from the board creation but not earlier than 7 days", () => {
    expect(defaultChangesSince(at(18, 9, 30), at(1), NOW)).toBe(at(18, 9, 30));
    expect(defaultChangesSince(null, at(24), NOW)).toBe(at(24));
    expect(defaultChangesSince(null, at(1), NOW)).toBe(new Date(NOW - 7 * DAY).toISOString());
    expect(defaultChangesSince(null, null, NOW)).toBe(new Date(NOW - 7 * DAY).toISOString());
    expect(defaultChangesSince("not a date", at(24), NOW)).toBe(at(24));
  });

  it("reads «с начала спринта» and «с даты…» as local midnight; without a date — the default period", () => {
    expect(localDayStartIso("2026-09-16")).toBe(new Date(2026, 8, 16).toISOString());
    expect(localDayStartIso("2026-09-16T00:00:00Z")).toBe(new Date(2026, 8, 16).toISOString());
    expect(localDayStartIso("2026-02-31")).toBeNull();
    expect(localDayStartIso("")).toBeNull();
    const base = {
      boardCreatedAt: at(1),
      customDate: "2026-09-20",
      now: NOW,
      seenAt: at(25),
      sprintStart: "2026-09-16",
    };
    expect(changesSinceForMode({ ...base, mode: "last_seen" })).toBe(at(25));
    expect(changesSinceForMode({ ...base, mode: "sprint" })).toBe(new Date(2026, 8, 16).toISOString());
    expect(changesSinceForMode({ ...base, mode: "date" })).toBe(new Date(2026, 8, 20).toISOString());
    expect(changesSinceForMode({ ...base, mode: "sprint", sprintStart: null })).toBe(at(25));
    expect(changesSinceForMode({ ...base, mode: "date", customDate: "" })).toBe(at(25));
    expect(changesPeriodKey("sprint", "", "2026-09-16")).toBe("sprint:2026-09-16");
    expect(changesPeriodKey("date", "2026-09-20", null)).toBe("date:2026-09-20");
    expect(changesDateBounds(NOW)).toEqual({ max: "2026-09-26", min: "2026-08-27" });
  });

  it("holds «с даты…» inside the window (min/max of the field do not stop typing) and waits 400 ms for typing", () => {
    expect(clampChangesDate("2026-09-20", NOW)).toBe("2026-09-20");
    expect(clampChangesDate("2025-01-01", NOW)).toBe("2026-08-27");
    // The year typed digit by digit: «0002» is a complete date in the field for a moment.
    expect(clampChangesDate("0002-09-20", NOW)).toBe("2026-08-27");
    expect(clampChangesDate("2026-12-31", NOW)).toBe("2026-09-26");
    expect(clampChangesDate("", NOW)).toBe("");
    expect(clampChangesDate("2026-02-31", NOW)).toBe("");
    expect(PPM_CHANGES_DATE_DEBOUNCE_MS).toBe(400);
  });
});

describe("loading the feeds", () => {
  const response = (since: string, items: TPpmBoardChange[] = []) => ({
    items,
    since,
    truncated: false,
    until: at(26),
  });

  it("fetches one feed for «с последнего просмотра», two when the open panel shows another period", async () => {
    const getSeen = vi.fn().mockResolvedValue({ seen_at: at(25), seen_version: 3 });
    const getChanges = vi.fn((since: string) => Promise.resolve(response(since)));
    const input = {
      boardCreatedAt: at(1),
      customDate: "",
      mode: "last_seen" as const,
      now: NOW,
      panelOpen: true,
      sprintStart: "2026-09-16",
    };

    const lastSeen = await loadBoardChanges({ getChanges, getSeen }, input);
    expect(getChanges.mock.calls.map(([since]) => since)).toEqual([at(25)]);
    expect(lastSeen).toMatchObject({ period: null, seenAt: at(25), unseen: { since: at(25) } });

    getChanges.mockClear();
    const sprint = await loadBoardChanges({ getChanges, getSeen }, { ...input, mode: "sprint" });
    expect(getChanges.mock.calls.map(([since]) => since)).toEqual([at(25), new Date(2026, 8, 16).toISOString()]);
    expect(sprint.unseen.since).toBe(at(25));
    expect(sprint.period).toMatchObject({ key: "sprint:2026-09-16", since: new Date(2026, 8, 16).toISOString() });

    getChanges.mockClear();
    const closed = await loadBoardChanges({ getChanges, getSeen }, { ...input, mode: "sprint", panelOpen: false });
    expect(getChanges).toHaveBeenCalledTimes(1);
    expect(closed.period).toBeNull();
  });

  it("keeps the same items array when nothing changed, so card marks do not re-render on every poll", () => {
    const items = [change({ id: "a", kind: "work_item.state" })];
    const loaded = { period: null, seenAt: at(25), unseen: { items, since: at(25), truncated: false } };
    const state = mergeLoadedChanges(INITIAL_BOARD_CHANGES_STATE, loaded);
    const again = mergeLoadedChanges(state, { ...loaded, unseen: { ...loaded.unseen, items: structuredClone(items) } });
    expect(again.unseen?.items).toBe(state.unseen?.items);
    expect(again.status).toBe("ready");
    // The task was put on the board later: same event, new card — the line becomes clickable and the card gets its mark.
    const placed = [{ ...items[0], shape_ids: ["shape:task"] }];
    const moved = mergeLoadedChanges(again, { ...loaded, unseen: { ...loaded.unseen, items: placed } });
    expect(moved.unseen?.items).toBe(placed);
  });

  it("shows «loading» only before the first answer and forgets the feed when it is unavailable", () => {
    expect(beginChangesLoad(INITIAL_BOARD_CHANGES_STATE).status).toBe("loading");
    const ready = mergeLoadedChanges(INITIAL_BOARD_CHANGES_STATE, {
      period: null,
      seenAt: null,
      unseen: { items: [], since: at(19), truncated: false },
    });
    expect(beginChangesLoad(ready)).toBe(ready);
    expect(failChangesLoad(ready, new PpmCanvasServiceError("down", { status: 500 }))).toMatchObject({
      status: "error",
      unseen: ready.unseen,
    });
    const unavailable = failChangesLoad(ready, new PpmCanvasServiceError("gone", { status: 404 }));
    expect(unavailable).toEqual({ ...INITIAL_BOARD_CHANGES_STATE, status: "unavailable" });
    expect(beginChangesLoad(unavailable)).toBe(unavailable);
  });

  it("«Отметить просмотренным» empties the unseen feed at once; a second return within 2 s does not reload", () => {
    const ready = mergeLoadedChanges(INITIAL_BOARD_CHANGES_STATE, {
      period: null,
      seenAt: at(20),
      unseen: {
        items: [change({ id: "a", kind: "work_item.state", shape_ids: ["shape:a"] })],
        since: at(20),
        truncated: true,
      },
    });
    const seen = applySeen(ready, at(26));
    expect(seen.unseen).toEqual({ items: [], since: at(26), truncated: false });
    expect(seen.seenAt).toBe(at(26));
    expect(buildBoardChangeIndex(seen.unseen?.items ?? []).byShapeId.size).toBe(0);
    expect(shouldRefreshOnReturn(NOW - 1_000, NOW)).toBe(false);
    expect(shouldRefreshOnReturn(NOW - 2_000, NOW)).toBe(true);
  });
});

describe("grouping the feed", () => {
  it("shows the newest value once per field, keeps every assignee change, «added» hides «changed» of the same card", () => {
    const items = [
      change({ id: "s1", kind: "work_item.state", occurred_at: at(21, 9), detail: { new: "Todo" } }),
      change({ id: "s2", kind: "work_item.state", occurred_at: at(22, 10), detail: { new: "In Progress" } }),
      change({ id: "a1", kind: "work_item.assignees", occurred_at: at(22, 11), detail: { old: "", new: "Олег С." } }),
      change({ id: "a2", kind: "work_item.assignees", occurred_at: at(22, 12), detail: { old: "Миша К.", new: "" } }),
      change({ id: "n1", kind: "board.node.added", occurred_at: at(20), entity: { type: "node", id: "node-1" } }),
      change({ id: "n2", kind: "board.node.changed", occurred_at: at(23), entity: { type: "node", id: "node-1" } }),
      change({ id: "n3", kind: "board.node.changed", occurred_at: at(24), entity: { type: "node", id: "node-2" } }),
    ];
    expect(groupBoardChanges(items).map((item) => item.id)).toEqual(["n3", "a2", "a1", "s2", "n1"]);
  });

  it("keeps every relation event: S2 already merged the two rows Plane writes for one relation", () => {
    const added = change({
      id: "r1",
      kind: "work_item.relation",
      detail: { field: "blocked_by", old: null, new: "ROBOT-12" },
    });
    const removed = change({
      id: "r2",
      kind: "work_item.relation",
      occurred_at: at(23),
      detail: { field: "blocked_by", old: "ROBOT-12", new: null },
    });
    expect(groupBoardChanges([added, removed]).map((item) => item.id)).toEqual(["r2", "r1"]);
  });
});

describe("marks on cards", () => {
  it("marks every card an unseen event touches; «added» wins over «changed»; tasks are also found by id", () => {
    const index = buildBoardChangeIndex([
      change({ id: "1", kind: "work_item.state", shape_ids: ["shape:task"] }),
      change({ id: "2", kind: "board.node.added", entity: { type: "node", id: "n" }, shape_ids: ["shape:note"] }),
      change({ id: "3", kind: "board.node.changed", entity: { type: "node", id: "n" }, shape_ids: ["shape:note"] }),
      change({
        id: "4",
        kind: "git.pull_request.merged",
        entity: { type: "pull_request", id: "pr", identifier: "#46" },
        shape_ids: ["shape:task"],
      }),
    ]);
    expect([...index.byShapeId]).toEqual([
      ["shape:task", "changed"],
      ["shape:note", "added"],
    ]);
    expect([...index.byWorkItemId]).toEqual([[TASK_15, "changed"]]);
  });
});

describe("my own changes (R9, controller's ruling)", () => {
  const me = { id: ME, display_name: "Анна Л." };
  const node = (id: string, shapeId: string, overrides: Partial<TPpmBoardChange> & Pick<TPpmBoardChange, "kind">) =>
    change({ id, entity: { type: "node", id: shapeId }, shape_ids: [shapeId], ...overrides });

  it("hides them from «с последнего просмотра» — the count, the list, the marks — and keeps them in other periods", () => {
    const items = [
      change({ id: "s-mine", kind: "work_item.state", actor: me, occurred_at: at(23), shape_ids: ["shape:task"] }),
      change({ id: "s-dasha", kind: "work_item.state", occurred_at: at(22), shape_ids: ["shape:task"] }),
      change({
        id: "a-dasha",
        kind: "work_item.assignees",
        occurred_at: at(21),
        detail: { old: null, new: "Олег С." },
        shape_ids: ["shape:task"],
      }),
      change({
        id: "n-mine",
        kind: "board.node.added",
        actor: me,
        occurred_at: at(20),
        entity: { type: "node", id: "shape:note" },
        shape_ids: ["shape:note"],
      }),
      // An edit S2 cannot attribute, of a card I added in this window: almost surely mine — it goes with my «added».
      change({
        id: "n-edit",
        kind: "board.node.changed",
        actor: null,
        occurred_at: at(24),
        entity: { type: "node", id: "shape:note" },
        shape_ids: ["shape:note"],
      }),
    ];
    // A task field keeps its newest value only: my status is the newest, so Dasha's older one is no news either.
    const unseen = unseenChangeEntries(items, ME);
    expect(unseen.map((item) => item.id)).toEqual(["a-dasha"]);
    expect([...buildBoardChangeIndex(unseen).byShapeId]).toEqual([["shape:task", "changed"]]);
    // «с начала спринта» and «с даты…» show every event, mine signed «Вы» (changes-format).
    expect(groupBoardChanges(items).map((item) => item.id)).toEqual(["s-mine", "a-dasha", "n-mine"]);
    // No user known (no provider): nothing is hidden.
    expect(unseenChangeEntries(items, "").map((item) => item.id)).toEqual(["s-mine", "a-dasha", "n-mine"]);
  });

  it("never hides someone else's change: Dasha's edit of my new card stays, my «added» goes", () => {
    const items = [
      node("n-mine", "shape:note", { kind: "board.node.added", actor: me, occurred_at: at(20) }),
      node("n-dasha", "shape:note", { kind: "board.node.changed", occurred_at: at(24) }),
      // An unattributed edit of a card nobody added in this window is not known to be mine: it stays.
      node("o-edit", "shape:old", { kind: "board.node.changed", actor: null, occurred_at: at(23) }),
      // My own edit of an older card (S2 names its author) goes.
      node("o-mine", "shape:older", { kind: "board.node.changed", actor: me, occurred_at: at(25) }),
      // Dasha's new card with my edit on it: her «added» stays.
      node("d-added", "shape:hers", { kind: "board.node.added", occurred_at: at(21) }),
      node("d-mine", "shape:hers", { kind: "board.node.changed", actor: me, occurred_at: at(22) }),
    ];
    const unseen = unseenChangeEntries(items, ME);
    expect(unseen.map((item) => item.id)).toEqual(["n-dasha", "o-edit", "d-added"]);
    expect([...buildBoardChangeIndex(unseen).byShapeId]).toEqual([
      ["shape:note", "changed"],
      ["shape:old", "changed"],
      ["shape:hers", "added"],
    ]);
  });
});

const ppmShape = (node: object, parentId = "page:page") => ({
  parentId,
  props: { node: JSON.stringify(node) },
  type: "ppm-canvas-node",
});

describe("the sprint of a map board", () => {
  it("finds the sprint frame (group with map.role = sprint) and ignores sections, other cards and broken nodes", () => {
    const group = createPpmCanvasNode({ authorId: ME, kind: "group", title: "Спринт 3" });
    const section = { ...group, map: { role: "section", module_id: null } };
    const sprint = { ...group, map: { role: "sprint", cycle_id: CYCLE } };
    const note = createPpmCanvasNode({ authorId: ME, kind: "note", title: "sprint" });
    const broken = { parentId: "page:page", type: "ppm-canvas-node", props: { node: '{"sprint"' } };
    expect(findSprintCycleId([ppmShape(section), ppmShape(note), broken, undefined, ppmShape(sprint)])).toBe(CYCLE);
    expect(findSprintCycleId([ppmShape(section), { parentId: "page:page", type: "geo", props: {} }])).toBeNull();
  });

  it("takes the first top-level sprint frame in page order — the rule of the map's header and tray (M-7)", () => {
    const group = createPpmCanvasNode({ authorId: ME, kind: "group", title: "Спринт" });
    const OTHER = "99999999-9999-4999-8999-999999999999";
    const sprint = (cycleId: string) => ({ ...group, map: { role: "sprint", cycle_id: cycleId } });
    // Рамка, вложенная в другую группу, картой доски не считается — даже раньше по порядку.
    expect(findSprintCycleId([ppmShape(sprint(OTHER), "shape:holder"), ppmShape(sprint(CYCLE))])).toBe(CYCLE);
    // ⌘C/⌘V чужой карты: вторая рамка верхнего уровня — после первой, берётся первая.
    expect(findSprintCycleId([ppmShape(sprint(CYCLE)), ppmShape(sprint(OTHER))])).toBe(CYCLE);
    expect(findSprintCycleId([ppmShape(sprint(OTHER), "shape:holder")])).toBeNull();
    // Одно правило с линией M: общий помощник firstSprintFrame (map-model.ts).
    const model = readFileSync(
      new URL("../../core/components/ppm-canvas/living-map/changes-model.ts", import.meta.url),
      "utf8"
    );
    expect(model).toContain("return firstSprintFrame(sprintMapGroups(shapes))?.map.cycle_id ?? null;");
  });
});

describe("showing a card from the feed", () => {
  function fakeEditor(pageOf: Record<string, string>, currentPage = "page:1") {
    const calls: unknown[][] = [];
    let page = currentPage;
    const editor = {
      centerOnPoint: (point: unknown, options: unknown) => {
        calls.push(["center", point, options]);
        return editor;
      },
      getAncestorPageId: (shape: { id: string }) => pageOf[shape.id],
      getCurrentPageId: () => page,
      getSelectionPageBounds: () => ({ center: { x: 50, y: 60 } }),
      getShape: (id: string) => (pageOf[id] ? { id, props: {}, type: "geo" } : undefined),
      select: (...ids: string[]) => {
        calls.push(["select", ...ids]);
        return editor;
      },
      setCurrentPage: (next: string) => {
        page = next;
        calls.push(["page", next]);
        return editor;
      },
    };
    return { calls, editor: editor as unknown as Editor };
  }

  it("goes to the card's sheet, selects the cards there and centres the camera without zooming", () => {
    const { calls, editor } = fakeEditor({ "shape:a": "page:2", "shape:b": "page:2", "shape:c": "page:1" });
    expect(focusChangeShapes(editor, ["shape:gone", "shape:a", "shape:c", "shape:b"])).toBe(true);
    expect(calls).toEqual([
      ["page", "page:2"],
      ["select", "shape:a", "shape:b"],
      ["center", { x: 50, y: 60 }, { animation: { duration: 220 } }],
    ]);
  });

  it("does nothing when none of the cards is on the board", () => {
    const { calls, editor } = fakeEditor({});
    expect(focusChangeShapes(editor, ["shape:gone"])).toBe(false);
    expect(calls).toEqual([]);
  });

  it("lists which cards of the feed are on the board as one stable key", () => {
    const entries = [
      change({ id: "1", kind: "work_item.state", shape_ids: ["shape:b", "shape:a"] }),
      change({ id: "2", kind: "work_item.name", shape_ids: ["shape:a", "shape:x"] }),
    ];
    expect(presentShapeKey(entries, (id) => id !== "shape:x")).toBe("shape:a\nshape:b");
  });
});

describe("useBoardChanges: F's contract, only the active board tab talks to the server (AF2.1 R19)", () => {
  const source = readFileSync(
    new URL("../../core/components/ppm-canvas/living-map/board-changes.ts", import.meta.url),
    "utf8"
  );

  it("keeps F's signature, stays empty without the v2 grammar and never imports the context (cycle)", () => {
    expect(source).toContain("export function useBoardChanges(args: TLivingMapArgs): TBoardChangeIndex {");
    expect(source).toMatch(/enabled\s*\?\s*\{\s*\.\.\.EMPTY_BOARD_CHANGE_INDEX,/);
    expect(source).toContain(": EMPTY_BOARD_CHANGE_INDEX,");
    expect(source).not.toContain("./living-map-context");
  });

  it("loads, listens to the window and polls only under v2 in the active tab; polls every 60 s while open", () => {
    expect(PPM_CHANGES_POLL_MS).toBe(60_000);
    expect(source.match(/if \(!enabled \|\| !isActive(?: \|\| !open)?(?: \|\| !editor)?\) return;/g)).toHaveLength(4);
    expect(source).toMatch(
      /window\.setInterval\(\(\) => \{\s*if \(document\.visibilityState === "visible"\) void load\(\);\s*\}, PPM_CHANGES_POLL_MS\)/
    );
    expect(source).toContain('window.addEventListener("focus", onReturn);');
    expect(source).toContain('document.addEventListener("visibilitychange", onReturn);');
    expect(source).toContain("}, [enabled, isActive, load, periodKey]);");
  });

  it("writes only the checkpoint, only from «Отметить просмотренным», and does not depend on edit rights", () => {
    expect(source.match(/service\.markSeen\(/g)).toHaveLength(1);
    expect(source).toMatch(
      /const markSeen = useCallback\(\(\) => \{[\s\S]*?service\.markSeen\(workspaceId, projectId, boardId\)/
    );
    expect(source).not.toMatch(/\.(post|patch|delete)\(/);
    expect(source).not.toContain("canEdit");
  });

  it("counts, marks and lists «с последнего просмотра» without my own changes; other periods keep them (R9)", () => {
    expect(source).toMatch(/const unseenEntries = useMemo\(\(\) => unseenChangeEntries\(unseenItems, authorId\),/);
    expect(source).toMatch(/const index = useMemo\(\(\) => buildBoardChangeIndex\(unseenEntries\),/);
    expect(source).toMatch(
      /effectiveMode === "last_seen" \? unseenEntries : periodItems \? groupBoardChanges\(periodItems\) : NO_CHANGES/
    );
    expect(source).toContain("count: unseenEntries.length,");
  });

  it("removes its listeners and timers and drops answers that come too late (after a newer load or the unmount)", () => {
    expect(source).toContain('window.removeEventListener("focus", onReturn);');
    expect(source).toContain('document.removeEventListener("visibilitychange", onReturn);');
    expect(source).toContain("return () => window.clearInterval(timer);");
    expect(source).toContain("const request = ++requestRef.current;");
    expect(source).toContain(
      "if (request === requestRef.current) setState((current) => mergeLoadedChanges(current, loaded));"
    );
    expect(source).toMatch(/\} catch \(error\) \{\s*if \(request !== requestRef\.current\) return;/);
    expect(source).toMatch(/return \(\) => \{\s*mountedRef\.current = false;\s*requestRef\.current \+= 1;\s*\};/);
  });

  it("after «Отметить просмотренным» reloads only a mounted board in the active tab; reopening clears the error", () => {
    const markSeen = source.slice(
      source.indexOf("const markSeen = useCallback("),
      source.indexOf("const unseenItems =")
    );
    expect(markSeen).toMatch(
      /await service\.markSeen\(workspaceId, projectId, boardId\);\s*if \(!mountedRef\.current\) return;/
    );
    expect(markSeen).toContain("if (liveRef.current) void load();");
    expect(source).toContain("liveRef.current = enabled && isActive;");
    expect(source).toMatch(/const setOpen = useCallback\(\(next: boolean\) => \{[^}]*setMarkError\(false\);/);
  });

  it("stops polling while the feed is unavailable and does not reopen the panel when the feed comes back", () => {
    expect(source).toContain('if (changesLoadStatus(error) === "unavailable") setOpenState(false);');
    expect(source).toMatch(/if \(!enabled \|\| !isActive \|\| !open\) return;\s*const timer = window\.setInterval/);
  });

  it("sends «с даты…» to the feed 400 ms after the last keystroke, held inside the window", () => {
    expect(source).toMatch(
      /const next = clampChangesDate\(customDate, Date\.now\(\)\);\s*if \(next === appliedDate\) return;\s*const timer = window\.setTimeout\(\(\) => setAppliedDate\(next\), PPM_CHANGES_DATE_DEBOUNCE_MS\);\s*return \(\) => window\.clearTimeout\(timer\);/
    );
    expect(source).toContain("const wantedKey = changesPeriodKey(effectiveMode, appliedDate, sprintStart);");
    expect(source).toContain("inputsRef.current = { boardCreatedAt, customDate: appliedDate,");
  });
});
