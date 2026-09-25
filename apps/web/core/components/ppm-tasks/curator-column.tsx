/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useTranslation } from "@plane/i18n";
import { EIssuesStoreType } from "@plane/types";
import { generateWorkItemLink } from "@plane/utils";
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { useIssues } from "@/hooks/store/use-issues";
import { useMember } from "@/hooks/store/use-member";
import { useProject } from "@/hooks/store/use-project";
import { useProjectState } from "@/hooks/store/use-project-state";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import {
  derivePpmTaskAttention,
  findPpmReviewStateIds,
  formatPpmChangedAt,
  formatPpmMemberShortName,
  formatPpmShortDate,
  getPpmMemberInitials,
  mergePpmLiveIssue,
  toPpmDateKey,
} from "./attention";
import { PpmCuratorColumnView } from "./curator-column-view";
import type { TPpmCuratorEntry, TPpmRecentEntry } from "./curator-column-view";
import { usePpmTasksData } from "./data-context";
import { formatPpmIssueIdentifier } from "./evidence";
import type { TPpmAttentionIssue } from "./evidence";
import { formatPpmTemplate, splitPpmTemplate } from "./format";
import { usePpmCuratorCollapsed } from "./use-curator-collapsed";

const SECTION_LIMIT = 5;

export const PpmTasksCuratorColumn = observer(function PpmTasksCuratorColumn(props: {
  workspaceSlug: string;
  projectId: string;
}) {
  const { workspaceSlug, projectId } = props;
  const data = usePpmTasksData();
  const ppmT = usePpmTranslation();
  const { currentLocale } = useTranslation();
  const { getProjectStates, getStateById } = useProjectState();
  const { getUserDetails } = useMember();
  const { getProjectIdentifierById } = useProject();
  const { issueMap } = useIssues(EIssuesStoreType.PROJECT);
  const { setPeekIssue } = useIssueDetail();
  const [collapsed, toggleCollapsed] = usePpmCuratorCollapsed();
  if (!data) return null;

  const now = new Date();
  const issues = (data.attention?.issues ?? []).map((item) => mergePpmLiveIssue(item, issueMap[item.id]));
  const attention = derivePpmTaskAttention({
    issues,
    todayKey: toPpmDateKey(now),
    getStateGroup: (stateId) => getStateById(stateId)?.group,
    reviewStateIds: findPpmReviewStateIds(getProjectStates(projectId)),
    getLiveStateId: (issueId) => issueMap[issueId]?.state_id,
  });

  const identifierOf = (item: { project_id: string; sequence_id: number }) =>
    formatPpmIssueIdentifier(getProjectIdentifierById(item.project_id), item.sequence_id);
  const hrefOf = (item: TPpmAttentionIssue) =>
    generateWorkItemLink({
      workspaceSlug,
      projectId: item.project_id,
      issueId: item.id,
      projectIdentifier: getProjectIdentifierById(item.project_id),
      sequenceId: item.sequence_id,
    });
  const assigneeOf = (item: TPpmAttentionIssue) =>
    item.assignee_ids[0]
      ? formatPpmMemberShortName(getUserDetails(item.assignee_ids[0])) || ppmT("tasks.curator.unassigned")
      : ppmT("tasks.curator.unassigned");
  const changedAt = (value: string) =>
    formatPpmChangedAt(value, now, currentLocale, {
      today: ppmT("tasks.curator.today_at"),
      yesterday: ppmT("tasks.curator.yesterday_at"),
    });
  const entryOf = (item: TPpmAttentionIssue, detail?: TPpmCuratorEntry["detail"]): TPpmCuratorEntry => ({
    id: item.id,
    href: hrefOf(item),
    identifier: identifierOf(item),
    title: item.name,
    byline: assigneeOf(item),
    detail,
  });
  const moreOf = (count: number) =>
    count > SECTION_LIMIT ? formatPpmTemplate(ppmT("tasks.curator.more"), { count: count - SECTION_LIMIT }) : undefined;

  const blockedEntries = attention.blocked.slice(0, SECTION_LIMIT).map(({ issue, blockers }) =>
    entryOf(issue, {
      prefix: `${ppmT("tasks.curator.waits_for")} `,
      code: formatPpmIssueIdentifier(getProjectIdentifierById(blockers[0].projectId), blockers[0].sequenceId),
      suffix: ` · ${blockers[0].name}${blockers.length > 1 ? ` +${blockers.length - 1}` : ""}`,
    })
  );
  const reviewSection = attention.review
    ? {
        count: attention.review.length,
        entries: attention.review.slice(0, SECTION_LIMIT).map((item) =>
          entryOf(item, {
            prefix: formatPpmTemplate(ppmT("tasks.curator.changed_at"), { when: changedAt(item.updated_at) }),
          })
        ),
        moreLabel: moreOf(attention.review.length),
      }
    : null;
  const overdueEntries = attention.overdue.slice(0, SECTION_LIMIT).map((item) =>
    entryOf(item, {
      prefix: formatPpmTemplate(ppmT("tasks.curator.due_on"), {
        date: formatPpmShortDate((item.target_date ?? "").slice(0, 10), currentLocale),
      }),
    })
  );
  const nearest = attention.nearestDue;
  const [nearestPrefix, nearestRest] = splitPpmTemplate(ppmT("tasks.curator.nearest_due"), "task");
  const nearestDetail =
    nearest && nearest.target_date
      ? {
          prefix: nearestPrefix,
          code: identifierOf(nearest),
          suffix: formatPpmTemplate(nearestRest, {
            date: formatPpmShortDate(nearest.target_date.slice(0, 10), currentLocale),
          }),
        }
      : undefined;
  const recent: TPpmRecentEntry[] = attention.recent.map((item) => {
    const author = item.updated_by ? getUserDetails(item.updated_by) : undefined;
    const name = formatPpmMemberShortName(author);
    return {
      id: item.id,
      href: hrefOf(item),
      identifier: identifierOf(item),
      title: item.name,
      initials: getPpmMemberInitials(author),
      byline: [name, changedAt(item.updated_at)].filter(Boolean).join(" · "),
    };
  });
  const payload = data.attention;
  const partialNote =
    payload && payload.totalCount > payload.issues.length
      ? formatPpmTemplate(ppmT("tasks.curator.partial"), { count: payload.issues.length })
      : undefined;

  return (
    <PpmCuratorColumnView
      labels={{
        title: ppmT("tasks.curator.title"),
        hide: ppmT("tasks.curator.hide"),
        show: ppmT("tasks.curator.show"),
        blocked: ppmT("tasks.curator.blocked"),
        blockedEmpty: ppmT("tasks.curator.blocked_empty"),
        review: ppmT("tasks.curator.review"),
        reviewEmpty: ppmT("tasks.curator.review_empty"),
        overdue: ppmT("tasks.curator.overdue"),
        overdueEmpty: ppmT("tasks.curator.overdue_empty"),
        recent: ppmT("tasks.curator.recent"),
        recentEmpty: ppmT("tasks.curator.recent_empty"),
        hint: ppmT("tasks.curator.hint"),
        loading: ppmT("tasks.curator.loading"),
        error: ppmT("tasks.curator.error"),
        retry: ppmT("tasks.curator.retry"),
      }}
      status={data.attentionStatus}
      collapsed={collapsed}
      attentionCount={attention.attentionCount}
      blocked={{
        count: attention.blocked.length,
        entries: blockedEntries,
        moreLabel: moreOf(attention.blocked.length),
      }}
      review={reviewSection}
      overdue={{
        count: attention.overdue.length,
        entries: overdueEntries,
        moreLabel: moreOf(attention.overdue.length),
        nearest: nearestDetail,
      }}
      recent={recent}
      partialNote={partialNote}
      onToggleCollapsed={toggleCollapsed}
      onRetry={data.retryAttention}
      onOpenIssue={(issueId) => {
        const item = issues.find((candidate) => candidate.id === issueId);
        setPeekIssue({ workspaceSlug, projectId: item?.project_id ?? projectId, issueId });
      }}
    />
  );
});
