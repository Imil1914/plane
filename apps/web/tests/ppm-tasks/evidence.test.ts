import { describe, expect, it } from "vitest";
import {
  collectPpmActiveBlockers,
  countPpmMaterials,
  formatPpmIssueIdentifier,
  formatPpmPullRequestRef,
  groupPpmPullRequestsByWorkItem,
  indexPpmRelationsByIssue,
  withoutPpmMaterialProperties,
} from "@/components/ppm-tasks/evidence";
import type { TPpmAttentionIssue } from "@/components/ppm-tasks/evidence";
import type { TPpmGitLink } from "@/services/ppm-git.service";

const link = (id: string, workItemId: string, patch: Partial<TPpmGitLink> = {}): TPpmGitLink => ({
  id,
  repository_id: "r1",
  repository_name: "robot",
  repository_provider: "github",
  work_item: { id: workItemId, identifier: "ROBOT-12", title: "Откалибровать датчик цвета" },
  object_type: "pull_request",
  ref: "48",
  title: "Калибровка датчика",
  canonical_url: "https://example.test/pr/48",
  status: "active",
  origin: "provider",
  git_object_id: null,
  git_object_state: null,
  created_at: "2026-09-20T10:00:00Z",
  updated_at: "2026-09-20T10:00:00Z",
  ...patch,
});

const issue = (id: string, relations: TPpmAttentionIssue["issue_relation"] = []): TPpmAttentionIssue => ({
  id,
  name: id,
  sequence_id: 1,
  project_id: "p1",
  state_id: "s-todo",
  target_date: null,
  updated_at: "2026-09-24T09:00:00Z",
  updated_by: "u1",
  assignee_ids: [],
  issue_relation: relations,
});

// Не захватывает переменные теста — вынесена из it(), чтобы не создавалась заново на каждый вызов.
const group = (stateId: string | null | undefined) =>
  (({ "s-progress": "started", "s-done": "completed" }) as Record<string, string>)[stateId ?? ""];

describe("task evidence", () => {
  it("groups only active pull requests by task, newest first", () => {
    const map = groupPpmPullRequestsByWorkItem([
      link("a", "i12", { updated_at: "2026-09-20T10:00:00Z" }),
      link("b", "i12", { ref: "51", updated_at: "2026-09-22T10:00:00Z" }),
      link("c", "i12", { object_type: "branch", ref: "feature/x" }),
      link("d", "i15", { status: "unlinked" }),
    ]);
    expect(map.get("i12")?.map((l) => l.ref)).toEqual(["51", "48"]);
    expect(map.has("i15")).toBe(false);
  });

  it("formats a PR number only when the ref is numeric", () => {
    expect(formatPpmPullRequestRef("48")).toBe("#48");
    expect(formatPpmPullRequestRef("#48")).toBe("#48");
    expect(formatPpmPullRequestRef("feature/x")).toBeNull();
  });

  it("keeps only blocked_by relations and drops finished blockers", () => {
    const relations = indexPpmRelationsByIssue([
      issue("i15", [
        {
          id: "i12",
          project_id: "p1",
          sequence_id: 12,
          name: "Датчик",
          relation_type: "blocked_by",
          state_id: "s-progress",
        },
        {
          id: "i7",
          project_id: "p1",
          sequence_id: 7,
          name: "Готовая",
          relation_type: "blocked_by",
          state_id: "s-done",
        },
        {
          id: "i9",
          project_id: "p1",
          sequence_id: 9,
          name: "Связанная",
          relation_type: "relates_to",
          state_id: "s-todo",
        },
      ]),
      issue("i3"),
    ]);
    expect(relations.get("i15")?.map((r) => r.id)).toEqual(["i12", "i7"]);
    expect(relations.has("i3")).toBe(false);
    expect(collectPpmActiveBlockers(relations.get("i15") ?? [], group).map((b) => b.sequenceId)).toEqual([12]);
    // живое состояние блокера из списка важнее ответа сервера
    expect(
      collectPpmActiveBlockers(relations.get("i15") ?? [], group, (id) => (id === "i12" ? "s-done" : undefined))
    ).toEqual([]);
  });

  it("counts materials the user shows and hides the duplicated chips", () => {
    const row = { attachment_count: 2, link_count: 1 };
    expect(countPpmMaterials(row, { attachment_count: true, link: true } as never)).toEqual({
      total: 3,
      attachments: 2,
      links: 1,
    });
    expect(countPpmMaterials(row, { attachment_count: false, link: true } as never).total).toBe(1);
    expect(countPpmMaterials(row, undefined).total).toBe(3);
    expect(withoutPpmMaterialProperties({ attachment_count: true, link: true, key: true } as never)).toMatchObject({
      attachment_count: false,
      link: false,
      key: true,
    });
  });

  it("builds identifiers with and without a known project", () => {
    expect(formatPpmIssueIdentifier("ROBOT", 12)).toBe("ROBOT-12");
    expect(formatPpmIssueIdentifier(undefined, 12)).toBe("#12");
  });
});
