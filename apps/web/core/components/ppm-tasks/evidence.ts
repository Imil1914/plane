/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { IIssueDisplayProperties } from "@plane/types";
import type { TPpmGitLink } from "@/services/ppm-git.service";

/** Связь из IssueListDetailSerializer (apps/api/plane/app/serializers/issue.py:874-897). */
export type TPpmAttentionRelation = {
  id: string;
  project_id: string;
  sequence_id: number;
  name: string;
  relation_type: string;
  state_id: string | null;
};

/** Задача из issues-detail (поля IssueListDetailSerializer.to_representation). */
export type TPpmAttentionIssue = {
  id: string;
  name: string;
  sequence_id: number;
  project_id: string;
  state_id: string | null;
  target_date: string | null;
  updated_at: string;
  updated_by: string | null;
  assignee_ids: string[];
  issue_relation?: TPpmAttentionRelation[];
};

export type TPpmBlocker = { id: string; projectId: string; sequenceId: number; name: string };
export type TPpmStateGroupLookup = (stateId: string | null | undefined) => string | undefined;

/** Неизвестная группа (статус чужого проекта не загружен) считается активной. */
export function isPpmActiveStateGroup(group: string | undefined): boolean {
  return group !== "completed" && group !== "cancelled";
}

export function groupPpmPullRequestsByWorkItem(links: readonly TPpmGitLink[]): Map<string, TPpmGitLink[]> {
  const map = new Map<string, TPpmGitLink[]>();
  for (const item of links) {
    if (item.object_type !== "pull_request" || item.status !== "active") continue;
    const list = map.get(item.work_item.id) ?? [];
    list.push(item);
    map.set(item.work_item.id, list);
  }
  for (const list of map.values()) list.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  return map;
}

export function formatPpmPullRequestRef(ref: string): string | null {
  const match = /^#?(\d+)$/.exec(ref.trim());
  return match ? `#${match[1]}` : null;
}

/** В ответе issues-detail relation_type всегда хранится как blocked_by (обратная сторона — blocking). */
export function indexPpmRelationsByIssue(issues: readonly TPpmAttentionIssue[]): Map<string, TPpmAttentionRelation[]> {
  const map = new Map<string, TPpmAttentionRelation[]>();
  for (const item of issues) {
    const blockedBy = (item.issue_relation ?? []).filter((relation) => relation.relation_type === "blocked_by");
    if (blockedBy.length) map.set(item.id, blockedBy);
  }
  return map;
}

export function collectPpmActiveBlockers(
  relations: readonly TPpmAttentionRelation[],
  getStateGroup: TPpmStateGroupLookup,
  getLiveStateId?: (issueId: string) => string | null | undefined
): TPpmBlocker[] {
  return relations
    .filter((relation) => {
      const liveStateId = getLiveStateId?.(relation.id);
      return isPpmActiveStateGroup(getStateGroup(liveStateId === undefined ? relation.state_id : liveStateId));
    })
    .map((relation) => ({
      id: relation.id,
      projectId: relation.project_id,
      sequenceId: relation.sequence_id,
      name: relation.name,
    }));
}

export function countPpmMaterials(
  issue: { attachment_count?: number | null; link_count?: number | null },
  displayProperties: IIssueDisplayProperties | undefined
): { total: number; attachments: number; links: number } {
  const attachments = displayProperties && !displayProperties.attachment_count ? 0 : (issue.attachment_count ?? 0);
  const links = displayProperties && !displayProperties.link ? 0 : (issue.link_count ?? 0);
  return { total: attachments + links, attachments, links };
}

/** Только для рендера строки: сохранённые настройки пользователя не меняются. */
export function withoutPpmMaterialProperties(
  displayProperties: IIssueDisplayProperties | undefined
): IIssueDisplayProperties | undefined {
  return displayProperties ? { ...displayProperties, attachment_count: false, link: false } : displayProperties;
}

export function formatPpmIssueIdentifier(projectIdentifier: string | undefined | null, sequenceId: number): string {
  return projectIdentifier ? `${projectIdentifier}-${sequenceId}` : `#${sequenceId}`;
}
