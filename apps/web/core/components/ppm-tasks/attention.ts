/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { collectPpmActiveBlockers, isPpmActiveStateGroup } from "./evidence";
import type { TPpmAttentionIssue, TPpmBlocker, TPpmStateGroupLookup } from "./evidence";
import { formatPpmTemplate } from "./format";

/** R6: «Ждёт проверки» — только статусы группы started с таким именем; статусы не создаём. */
export const PPM_REVIEW_STATE_PATTERN = /провер|review/i;
const RECENT_LIMIT = 5;

export type TPpmAttention = {
  blocked: Array<{ issue: TPpmAttentionIssue; blockers: TPpmBlocker[] }>;
  review: TPpmAttentionIssue[] | null;
  overdue: TPpmAttentionIssue[];
  nearestDue: TPpmAttentionIssue | null;
  recent: TPpmAttentionIssue[];
  attentionCount: number;
};

export function findPpmReviewStateIds(
  states: ReadonlyArray<{ id: string; name: string; group: string }> | undefined
): Set<string> {
  return new Set(
    (states ?? [])
      .filter((state) => state.group === "started" && PPM_REVIEW_STATE_PATTERN.test(state.name))
      .map((state) => state.id)
  );
}

const pad = (value: number) => String(value).padStart(2, "0");

export function toPpmDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dateKeyOf(value: string | null | undefined): string | null {
  return value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

const byUpdatedDesc = (a: TPpmAttentionIssue, b: TPpmAttentionIssue) =>
  Date.parse(b.updated_at) - Date.parse(a.updated_at);

/** Sorted copy; the input is never mutated. */
function sortedCopy<T>(items: readonly T[], compare: (a: T, b: T) => number): T[] {
  // oxlint-disable-next-line unicorn/no-array-sort -- sorts a local copy (ES2022 lib has no toSorted)
  return [...items].sort(compare);
}

export function derivePpmTaskAttention(input: {
  issues: readonly TPpmAttentionIssue[];
  todayKey: string;
  getStateGroup: TPpmStateGroupLookup;
  reviewStateIds: ReadonlySet<string>;
  getLiveStateId?: (issueId: string) => string | null | undefined;
}): TPpmAttention {
  const { issues, todayKey, getStateGroup, reviewStateIds, getLiveStateId } = input;
  const active = issues.filter((item) => isPpmActiveStateGroup(getStateGroup(item.state_id)));
  const blocked = sortedCopy(
    active
      .map((item) => ({
        issue: item,
        blockers: collectPpmActiveBlockers(
          (item.issue_relation ?? []).filter((relation) => relation.relation_type === "blocked_by"),
          getStateGroup,
          getLiveStateId
        ),
      }))
      .filter((entry) => entry.blockers.length > 0),
    (a, b) => byUpdatedDesc(a.issue, b.issue)
  );
  const review = reviewStateIds.size
    ? sortedCopy(
        active.filter((item) => !!item.state_id && reviewStateIds.has(item.state_id)),
        byUpdatedDesc
      )
    : null;
  const dated = sortedCopy(
    active
      .map((item) => ({ item, key: dateKeyOf(item.target_date) }))
      .filter((entry): entry is { item: TPpmAttentionIssue; key: string } => entry.key !== null),
    (a, b) => (a.key === b.key ? a.item.sequence_id - b.item.sequence_id : a.key < b.key ? -1 : 1)
  );
  const overdue = dated.filter((entry) => entry.key < todayKey).map((entry) => entry.item);
  const nearestDue = dated.find((entry) => entry.key >= todayKey)?.item ?? null;
  const recent = sortedCopy(issues, byUpdatedDesc).slice(0, RECENT_LIMIT);
  const attentionIds = new Set([
    ...blocked.map((entry) => entry.issue.id),
    ...(review ?? []).map((item) => item.id),
    ...overdue.map((item) => item.id),
  ]);
  return { blocked, review, overdue, nearestDue, recent, attentionCount: attentionIds.size };
}

type TLiveFields = Partial<
  Pick<TPpmAttentionIssue, "state_id" | "target_date" | "name" | "assignee_ids" | "updated_at" | "updated_by">
>;

/** Живые значения из issueMap (инлайн-правки в списке) важнее снимка issues-detail. */
export function mergePpmLiveIssue(item: TPpmAttentionIssue, live: TLiveFields | undefined): TPpmAttentionIssue {
  if (!live) return item;
  return {
    ...item,
    state_id: live.state_id ?? item.state_id,
    target_date: live.target_date !== undefined ? live.target_date : item.target_date,
    name: live.name ?? item.name,
    assignee_ids: live.assignee_ids ?? item.assignee_ids,
    updated_at: live.updated_at ?? item.updated_at,
    updated_by: live.updated_by ?? item.updated_by,
  };
}

const langOf = (locale: string | undefined) => (locale?.toLowerCase().startsWith("ru") ? "ru" : "en");

export function formatPpmShortDate(dateKey: string, locale: string | undefined): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Intl.DateTimeFormat(langOf(locale), { day: "numeric", month: "short", timeZone: "UTC" }).format(
    Date.UTC(year, month - 1, day)
  );
}

export function formatPpmChangedAt(
  value: string,
  now: Date,
  locale: string | undefined,
  templates: { today: string; yesterday: string }
): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const lang = langOf(locale);
  const time = new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit" }).format(date);
  const dayKey = toPpmDateKey(date);
  if (dayKey === toPpmDateKey(now)) return formatPpmTemplate(templates.today, { time });
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey === toPpmDateKey(yesterday)) return formatPpmTemplate(templates.yesterday, { time });
  return `${new Intl.DateTimeFormat(lang, { day: "numeric", month: "short" }).format(date)}, ${time}`;
}

type TMemberName = { first_name?: string; last_name?: string; display_name?: string } | undefined;

export function formatPpmMemberShortName(user: TMemberName): string {
  if (!user) return "";
  const first = user.first_name?.trim();
  const last = user.last_name?.trim();
  if (first && last) return `${first} ${last[0]}.`;
  return first || user.display_name?.trim() || "";
}

export function getPpmMemberInitials(user: TMemberName): string {
  if (!user) return "";
  const first = user.first_name?.trim();
  const last = user.last_name?.trim();
  if (first && last) return `${first[0]}${last[0]}`.toUpperCase();
  return (first || user.display_name?.trim() || "").slice(0, 2).toUpperCase();
}
