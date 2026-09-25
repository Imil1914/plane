/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { observer } from "mobx-react";
import useSWR from "swr";
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { useWorkspace } from "@/hooks/store/use-workspace";
import type { TPpmGitLink } from "@/services/ppm-git.service";
import { groupPpmPullRequestsByWorkItem, indexPpmRelationsByIssue } from "./evidence";
import type { TPpmAttentionRelation } from "./evidence";
import { fetchPpmTasksAttention, PpmTaskGitLinksService } from "./services";
import type { TPpmAttentionPayload } from "./services";

export type TPpmTasksData = {
  workspaceSlug: string;
  projectId: string;
  attention: TPpmAttentionPayload | undefined;
  attentionStatus: "loading" | "error" | "ready";
  retryAttention: () => void;
  relationsByIssue: Map<string, TPpmAttentionRelation[]>;
  pullRequestsByIssue: Map<string, TPpmGitLink[]>;
};

const PpmTasksDataContext = createContext<TPpmTasksData | null>(null);
const gitLinksService = new PpmTaskGitLinksService();
const EMPTY_RELATIONS = new Map<string, TPpmAttentionRelation[]>();
const EMPTY_PULL_REQUESTS = new Map<string, TPpmGitLink[]>();

type Props = { workspaceSlug: string; projectId: string; enabled: boolean; children: ReactNode };

/** Ставится только в project-layout-root (v2). Другие list-корни контекста не получают — строки без полоски. */
export const PpmTasksDataProvider = observer(function PpmTasksDataProvider(props: Props) {
  const { workspaceSlug, projectId, enabled, children } = props;
  const { getWorkspaceBySlug } = useWorkspace();
  const { peekIssue } = useIssueDetail();
  const workspaceId = getWorkspaceBySlug(workspaceSlug)?.id;

  // Оба запроса тяжёлые (issues-detail со связями до 1000 задач, все Git-связи проекта): не перезапрашиваем на каждый
  // фокус окна. Сводка обновляется после закрытия peek и по «Повторить»; инлайн-правки строк приходят из issueMap.
  const attentionQuery = useSWR(
    enabled ? ["ppm-tasks-attention", workspaceSlug, projectId] : null,
    () => fetchPpmTasksAttention(workspaceSlug, projectId),
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  const gitQuery = useSWR(
    enabled && workspaceId ? ["ppm-tasks-git-links", workspaceId, projectId] : null,
    () => gitLinksService.listLinks(workspaceId as string, projectId),
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );

  // Связи и сроки могли поменяться в карточке задачи: один перезапрос после закрытия peek.
  const isPeekOpen = !!peekIssue;
  const wasPeekOpen = useRef(isPeekOpen);
  const mutateAttention = attentionQuery.mutate;
  useEffect(() => {
    if (wasPeekOpen.current && !isPeekOpen && enabled) void mutateAttention();
    wasPeekOpen.current = isPeekOpen;
  }, [isPeekOpen, enabled, mutateAttention]);

  const attention = attentionQuery.data;
  const gitLinks = gitQuery.data?.links;
  const relationsByIssue = useMemo(
    () => (attention ? indexPpmRelationsByIssue(attention.issues) : EMPTY_RELATIONS),
    [attention]
  );
  const pullRequestsByIssue = useMemo(
    () => (gitLinks ? groupPpmPullRequestsByWorkItem(gitLinks) : EMPTY_PULL_REQUESTS),
    [gitLinks]
  );
  const attentionStatus: TPpmTasksData["attentionStatus"] = attentionQuery.error
    ? "error"
    : attention
      ? "ready"
      : "loading";

  const value = useMemo<TPpmTasksData>(
    () => ({
      workspaceSlug,
      projectId,
      attention,
      attentionStatus,
      retryAttention: () => void mutateAttention(),
      relationsByIssue,
      pullRequestsByIssue,
    }),
    [workspaceSlug, projectId, attention, attentionStatus, mutateAttention, relationsByIssue, pullRequestsByIssue]
  );

  return <PpmTasksDataContext.Provider value={value}>{children}</PpmTasksDataContext.Provider>;
});

export function usePpmTasksData(): TPpmTasksData | null {
  return useContext(PpmTasksDataContext);
}
