/**
 * Copyright (c) 2026 PPM contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// G2.2 (R18): pure formatting for the admin center's «Git-сервер» tab, kept outside the component so it is unit
// tested without rendering — the same split `git-provider-labels.ts` uses for the «Код» page.
import type { TPpmTranslationKey } from "@ppm/brand";
import type { TPpmAdminGitServerCounts } from "@/services/ppm-admin.service";

const SYNC_STATUS_KEYS: Record<string, TPpmTranslationKey> = {
  ok: "g22.admin.git_sync_status_ok",
  partial: "g22.admin.git_sync_status_partial",
  error: "g22.admin.git_sync_status_error",
};

/** The last full reconciliation's outcome label key, or undefined for a value the API has not defined yet. */
export function getSyncStatusLabelKey(status: string): TPpmTranslationKey | undefined {
  return SYNC_STATUS_KEYS[status];
}

/**
 * Review round 1 (Important #2): show only the fixed, ordered list of counts the plan names — `accounts`,
 * `organizations`, `teams`, `repositories`, `changes` — instead of an open dictionary of whatever keys the sync
 * engine happens to send (S2's exact key set was undecided when this was first written; it no longer is). A key
 * missing from the API's answer reads as 0, so the layout is always the same five tiles.
 */
export const GIT_SERVER_COUNT_FIELDS: ReadonlyArray<{
  key: keyof TPpmAdminGitServerCounts;
  labelKey: TPpmTranslationKey;
}> = [
  { key: "accounts", labelKey: "g22.admin.git_counts_accounts" },
  { key: "organizations", labelKey: "g22.admin.git_counts_organizations" },
  { key: "teams", labelKey: "g22.admin.git_counts_teams" },
  { key: "repositories", labelKey: "g22.admin.git_counts_repositories" },
  { key: "changes", labelKey: "g22.admin.git_counts_changes" },
];

/** Whole seconds between two ISO timestamps, or null if either is missing/unparsable/out of order. */
export function getSyncDurationSeconds(startedAt: string | null | undefined, finishedAt: string | null | undefined) {
  if (!startedAt || !finishedAt) return null;
  const started = new Date(startedAt).getTime();
  const finished = new Date(finishedAt).getTime();
  if (Number.isNaN(started) || Number.isNaN(finished) || finished < started) return null;
  return Math.round((finished - started) / 1000);
}

const PROBLEM_KIND_KEYS: Record<string, TPpmTranslationKey> = {
  account: "g22.admin.git_problem_kind_account",
  organization: "g22.admin.git_problem_kind_organization",
  project: "g22.admin.git_problem_kind_project",
  team: "g22.admin.git_problem_kind_team",
  // Round 2 (Minor D-3, live-stack E): was missing — a repository-level problem showed its raw code untranslated.
  repository: "g22.admin.git_problem_kind_repository",
  forgejo: "g22.admin.git_problem_kind_forgejo",
  ppm: "g22.admin.git_problem_kind_ppm",
};

/** A problem's `kind` in Russian (R18: «понятный текст») — undefined for a value the API has not defined yet, so
 * the caller can fall back to the raw code rather than guessing a translation. */
export function getProblemKindLabelKey(kind: string): TPpmTranslationKey | undefined {
  return PROBLEM_KIND_KEYS[kind];
}

/**
 * Round 2 (live-stack E, reconciled with S2b): a count of `null` means the sync engine does not know that number
 * yet (not zero) — shown as «—», the same convention `formatDateTime`/`ProblemRow` already use for an absent value.
 */
export function formatCount(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : String(value);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Review round 1 (#6): a problem row never shows a raw id as its subject — only a human-readable one (an email, a
 * username, a slug); a bare UUID is dropped instead (the row's `message` already carries the human explanation). */
export function isUuidLike(value: string): boolean {
  return UUID_PATTERN.test(value);
}
