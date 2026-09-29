// G2.2 (R18): pure formatting behind the admin center's «Git-сервер» tab, tested without rendering (same split as
// git-provider-labels.ts's tests for the «Код» page).
import { describe, expect, it } from "vitest";
import {
  GIT_SERVER_COUNT_FIELDS,
  getProblemKindLabelKey,
  getSyncDurationSeconds,
  getSyncStatusLabelKey,
  isUuidLike,
} from "@/components/ppm-admin/ppm-git-server-status.helper";

describe("getSyncStatusLabelKey", () => {
  it("names the three documented outcomes", () => {
    expect(getSyncStatusLabelKey("ok")).toBe("g22.admin.git_sync_status_ok");
    expect(getSyncStatusLabelKey("partial")).toBe("g22.admin.git_sync_status_partial");
    expect(getSyncStatusLabelKey("error")).toBe("g22.admin.git_sync_status_error");
  });

  it("is undefined for anything the API has not defined yet, so the caller can fall back safely", () => {
    expect(getSyncStatusLabelKey("running")).toBeUndefined();
    expect(getSyncStatusLabelKey("")).toBeUndefined();
  });
});

// Review round 1 (Important #2): the fixed, ordered list the plan names — no longer an open dictionary that
// humanizes whatever key the sync engine happens to send.
describe("GIT_SERVER_COUNT_FIELDS", () => {
  it("is exactly the five counts from the plan, in this order", () => {
    expect(GIT_SERVER_COUNT_FIELDS.map((field) => field.key)).toEqual([
      "accounts",
      "organizations",
      "teams",
      "repositories",
      "changes",
    ]);
  });

  it("names each field's translation key", () => {
    expect(GIT_SERVER_COUNT_FIELDS).toEqual([
      { key: "accounts", labelKey: "g22.admin.git_counts_accounts" },
      { key: "organizations", labelKey: "g22.admin.git_counts_organizations" },
      { key: "teams", labelKey: "g22.admin.git_counts_teams" },
      { key: "repositories", labelKey: "g22.admin.git_counts_repositories" },
      { key: "changes", labelKey: "g22.admin.git_counts_changes" },
    ]);
  });
});

describe("getProblemKindLabelKey", () => {
  it("names the six problem kinds round 1 asks for", () => {
    expect(getProblemKindLabelKey("account")).toBe("g22.admin.git_problem_kind_account");
    expect(getProblemKindLabelKey("organization")).toBe("g22.admin.git_problem_kind_organization");
    expect(getProblemKindLabelKey("project")).toBe("g22.admin.git_problem_kind_project");
    expect(getProblemKindLabelKey("team")).toBe("g22.admin.git_problem_kind_team");
    expect(getProblemKindLabelKey("forgejo")).toBe("g22.admin.git_problem_kind_forgejo");
    expect(getProblemKindLabelKey("ppm")).toBe("g22.admin.git_problem_kind_ppm");
  });

  it("is undefined for a kind the API has not defined yet, so the caller falls back to the raw code, not a guess", () => {
    expect(getProblemKindLabelKey("unknown_kind")).toBeUndefined();
    expect(getProblemKindLabelKey("")).toBeUndefined();
  });
});

describe("isUuidLike", () => {
  it("recognizes a UUID regardless of case", () => {
    expect(isUuidLike("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(isUuidLike("11111111-1111-4111-8111-111111111111".toUpperCase())).toBe(true);
  });

  it("is false for a human-readable subject (email, username, slug)", () => {
    expect(isUuidLike("person@example.com")).toBe(false);
    expect(isUuidLike("robot")).toBe(false);
    expect(isUuidLike("lab/robot")).toBe(false);
    expect(isUuidLike("")).toBe(false);
  });
});

describe("getSyncDurationSeconds", () => {
  it("computes whole seconds between the start and the end", () => {
    expect(getSyncDurationSeconds("2026-09-29T02:00:00Z", "2026-09-29T02:00:07Z")).toBe(7);
    expect(getSyncDurationSeconds("2026-09-29T02:00:00.200Z", "2026-09-29T02:00:07.900Z")).toBe(8);
  });

  it("is null without both timestamps, on unparsable input, or when finished precedes started", () => {
    expect(getSyncDurationSeconds(null, "2026-09-29T02:00:07Z")).toBeNull();
    expect(getSyncDurationSeconds("2026-09-29T02:00:00Z", null)).toBeNull();
    expect(getSyncDurationSeconds(undefined, undefined)).toBeNull();
    expect(getSyncDurationSeconds("not a date", "2026-09-29T02:00:07Z")).toBeNull();
    expect(getSyncDurationSeconds("2026-09-29T02:00:07Z", "2026-09-29T02:00:00Z")).toBeNull();
  });
});
