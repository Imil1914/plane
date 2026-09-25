/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL } from "@plane/constants";
import { APIService } from "@/services/api.service";
import { IssueService } from "@/services/issue";
import type { TPpmGitCapabilities, TPpmGitLink } from "@/services/ppm-git.service";
import type { TPpmAttentionIssue } from "./evidence";

export const PPM_ATTENTION_PAGE_SIZE = 1000;

export type TPpmAttentionPayload = { issues: TPpmAttentionIssue[]; totalCount: number };
export type TPpmGitLinksPayload = { capabilities: TPpmGitCapabilities; links: TPpmGitLink[] };

const issueService = new IssueService();

/** Один запрос на загрузку списка: существующий issues-detail с префетчем связей (без N+1). */
export async function fetchPpmTasksAttention(workspaceSlug: string, projectId: string): Promise<TPpmAttentionPayload> {
  const response = await issueService.getIssuesFromServer(workspaceSlug, projectId, {
    expand: "issue_relation",
    order_by: "-updated_at",
    per_page: PPM_ATTENTION_PAGE_SIZE,
  });
  const issues = Array.isArray(response?.results) ? (response.results as unknown as TPpmAttentionIssue[]) : [];
  return { issues, totalCount: typeof response?.total_count === "number" ? response.total_count : issues.length };
}

/** Один запрос на проект: все активные Git-связи (ppm_git/views.py:639-649). 403/404 — «нет данных». */
export class PpmTaskGitLinksService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  async listLinks(workspaceId: string, projectId: string): Promise<TPpmGitLinksPayload | null> {
    try {
      const response = await this.get(`/api/ppm/v1/workspaces/${workspaceId}/projects/${projectId}/git/links/`);
      return response.data as TPpmGitLinksPayload;
    } catch {
      return null;
    }
  }
}
