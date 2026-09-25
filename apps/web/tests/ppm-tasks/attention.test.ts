import { describe, expect, it } from "vitest";
import {
  derivePpmTaskAttention,
  findPpmReviewStateIds,
  formatPpmChangedAt,
  formatPpmMemberShortName,
  getPpmMemberInitials,
  mergePpmLiveIssue,
  toPpmDateKey,
} from "@/components/ppm-tasks/attention";
import type { TPpmAttentionIssue } from "@/components/ppm-tasks/evidence";

const STATES = [
  { id: "s-backlog", name: "Backlog", group: "backlog" },
  { id: "s-todo", name: "Todo", group: "unstarted" },
  { id: "s-progress", name: "In Progress", group: "started" },
  { id: "s-review", name: "На проверке", group: "started" },
  { id: "s-done", name: "Done", group: "completed" },
  { id: "s-cancel", name: "Cancelled", group: "cancelled" },
];
const groupOf = (stateId: string | null | undefined) => STATES.find((s) => s.id === stateId)?.group;
const make = (seq: number, stateId: string, patch: Partial<TPpmAttentionIssue> = {}): TPpmAttentionIssue => ({
  id: `i${seq}`,
  name: `Задача ${seq}`,
  sequence_id: seq,
  project_id: "p1",
  state_id: stateId,
  target_date: null,
  updated_at: `2026-09-2${Math.min(seq, 9)}T08:00:00Z`,
  updated_by: "u1",
  assignee_ids: [],
  issue_relation: [],
  ...patch,
});
const blockedBy = (seq: number, stateId: string) => ({
  id: `i${seq}`,
  project_id: "p1",
  sequence_id: seq,
  name: `Задача ${seq}`,
  relation_type: "blocked_by",
  state_id: stateId,
});

const ISSUES = [
  make(15, "s-todo", { issue_relation: [blockedBy(12, "s-progress")] }),
  make(12, "s-progress", { target_date: "2026-09-26" }),
  make(9, "s-review"),
  make(7, "s-done", { target_date: "2026-09-20" }),
  make(3, "s-todo", { issue_relation: [blockedBy(7, "s-done")] }),
  make(4, "s-backlog", { target_date: "2026-09-22" }),
  make(5, "s-cancel", { target_date: "2026-09-01" }),
  make(6, "s-todo", { target_date: "2026-09-24" }),
];

describe("curator attention", () => {
  it("finds review states only in the started group by name", () => {
    expect([...findPpmReviewStateIds(STATES)]).toEqual(["s-review"]);
    expect(findPpmReviewStateIds([{ id: "x", name: "Review", group: "unstarted" }]).size).toBe(0);
    expect(findPpmReviewStateIds([{ id: "y", name: "Code review", group: "started" }]).has("y")).toBe(true);
  });

  it("derives blocked, review, overdue (strictly before today), nearest due and recent", () => {
    const result = derivePpmTaskAttention({
      issues: ISSUES,
      todayKey: "2026-09-24",
      getStateGroup: groupOf,
      reviewStateIds: findPpmReviewStateIds(STATES),
    });
    expect(result.blocked.map((b) => [b.issue.sequence_id, b.blockers.map((x) => x.sequenceId)])).toEqual([[15, [12]]]);
    expect(result.review?.map((i) => i.sequence_id)).toEqual([9]);
    expect(result.overdue.map((i) => i.sequence_id)).toEqual([4]);
    expect(result.nearestDue?.sequence_id).toBe(6);
    expect(result.attentionCount).toBe(3);
    expect(result.recent).toHaveLength(5);
  });

  it("hides the review section when the project has no review state", () => {
    const result = derivePpmTaskAttention({
      issues: ISSUES,
      todayKey: "2026-09-24",
      getStateGroup: groupOf,
      reviewStateIds: new Set(),
    });
    expect(result.review).toBeNull();
  });

  it("handles an empty project", () => {
    const result = derivePpmTaskAttention({
      issues: [],
      todayKey: "2026-09-24",
      getStateGroup: groupOf,
      reviewStateIds: new Set(["s-review"]),
    });
    expect(result).toMatchObject({
      blocked: [],
      review: [],
      overdue: [],
      nearestDue: null,
      recent: [],
      attentionCount: 0,
    });
  });

  it("prefers live list values over the fetched snapshot", () => {
    const merged = mergePpmLiveIssue(make(4, "s-backlog", { target_date: "2026-09-22" }), {
      state_id: "s-done",
      target_date: "2026-09-22",
      name: "Новое имя",
      assignee_ids: ["u2"],
      updated_at: "2026-09-24T10:00:00Z",
      updated_by: "u2",
    });
    expect(merged).toMatchObject({ state_id: "s-done", name: "Новое имя", assignee_ids: ["u2"], updated_by: "u2" });
  });

  it("formats change time as today / yesterday / date", () => {
    const now = new Date(2026, 8, 24, 15, 0);
    const labels = { today: "сегодня, {time}", yesterday: "вчера, {time}" };
    expect(formatPpmChangedAt(new Date(2026, 8, 24, 11, 52).toISOString(), now, "ru", labels)).toBe("сегодня, 11:52");
    expect(formatPpmChangedAt(new Date(2026, 8, 23, 17, 30).toISOString(), now, "ru", labels)).toBe("вчера, 17:30");
    expect(formatPpmChangedAt(new Date(2026, 8, 20, 9, 5).toISOString(), now, "ru", labels)).toBe("20 сент., 09:05");
    expect(toPpmDateKey(now)).toBe("2026-09-24");
  });

  it("shortens member names like the mockup", () => {
    expect(formatPpmMemberShortName({ first_name: "Даша", last_name: "Петрова", display_name: "dasha" })).toBe(
      "Даша П."
    );
    expect(formatPpmMemberShortName({ first_name: "", last_name: "", display_name: "oleg" })).toBe("oleg");
    expect(formatPpmMemberShortName(undefined)).toBe("");
    expect(getPpmMemberInitials({ first_name: "Даша", last_name: "Петрова", display_name: "dasha" })).toBe("ДП");
    expect(getPpmMemberInitials({ first_name: "", last_name: "", display_name: "oleg" })).toBe("OL");
  });
});
