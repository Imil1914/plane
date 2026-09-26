/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { isAxiosError } from "axios";
import { z } from "zod";
import { API_BASE_URL } from "@plane/constants";
import { ppmCanvasErrorResponseSchema } from "@ppm/canvas";
import { APIService } from "@/services/api.service";
import { PpmCanvasServiceError } from "@/services/ppm-canvas.service";

// AF2.2 C · «Что изменилось» и «На карте» (сервер S, CONTRACTS §5): S2 — лента изменений доски, S3 — личная отметка
// просмотра, S4 — доски, где лежит задача. Ленту разбираем по пунктам: пункт неизвестного вида или с битыми полями
// отбрасывается, остальные показываются — новый вид события на сервере не ломает панель.

export const PPM_BOARD_CHANGE_KINDS = [
  "work_item.state",
  "work_item.assignees",
  "work_item.due",
  "work_item.priority",
  "work_item.name",
  "work_item.relation",
  "git.pull_request.opened",
  "git.pull_request.merged",
  "vault.version",
  "board.node.added",
  "board.node.changed",
] as const;

/** Не больше 200 событий за запрос (S2). */
export const PPM_BOARD_CHANGES_LIMIT = 200;

const isoDateTime = z.string().datetime({ offset: true });

export const ppmBoardChangeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(PPM_BOARD_CHANGE_KINDS),
  occurred_at: isoDateTime,
  actor: z.object({ id: z.string().min(1), display_name: z.string() }).nullable(),
  entity: z.object({
    type: z.string().min(1),
    id: z.string().min(1),
    identifier: z.string().nullish(),
    title: z.string().nullish(),
  }),
  shape_ids: z.array(z.string().min(1)).default([]),
  detail: z
    .object({ field: z.string().nullish(), old: z.unknown().optional(), new: z.unknown().optional() })
    .default({}),
});
export type TPpmBoardChange = z.infer<typeof ppmBoardChangeSchema>;

const ppmBoardChangesEnvelopeSchema = z.object({
  since: isoDateTime,
  until: isoDateTime,
  items: z.array(z.unknown()),
  truncated: z.boolean(),
});
export type TPpmBoardChangesResponse = {
  items: TPpmBoardChange[];
  since: string;
  truncated: boolean;
  until: string;
};

export const ppmBoardSeenSchema = z.object({
  seen_at: isoDateTime.nullable().default(null),
  seen_version: z.number().int().nonnegative().nullable().default(null),
});
export type TPpmBoardSeen = z.infer<typeof ppmBoardSeenSchema>;

export const ppmWorkItemBoardsResponseSchema = z.object({
  results: z.array(z.object({ board_id: z.string().uuid(), name: z.string(), shape_id: z.string().min(1) })),
});
export type TPpmWorkItemBoard = z.infer<typeof ppmWorkItemBoardsResponseSchema>["results"][number];

export class PpmCanvasChangesService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  async getChanges(
    workspaceId: string,
    projectId: string,
    boardId: string,
    since: string,
    limit = PPM_BOARD_CHANGES_LIMIT
  ): Promise<TPpmBoardChangesResponse> {
    try {
      const response = await this.get(`${this.boardPath(workspaceId, projectId, boardId)}changes/`, {
        params: { since, limit: Math.min(Math.max(Math.trunc(limit), 1), PPM_BOARD_CHANGES_LIMIT) },
      });
      const envelope = ppmBoardChangesEnvelopeSchema.parse(response.data);
      const items = envelope.items.flatMap((item) => {
        const parsed = ppmBoardChangeSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      });
      return { items, since: envelope.since, truncated: envelope.truncated, until: envelope.until };
    } catch (error) {
      throw normalizeChangesError(error);
    }
  }

  async getSeen(workspaceId: string, projectId: string, boardId: string): Promise<TPpmBoardSeen> {
    try {
      const response = await this.get(`${this.boardPath(workspaceId, projectId, boardId)}me/`);
      // «Ещё не смотрел» — `{ seen_at: null, … }` или пустой ответ.
      return ppmBoardSeenSchema.parse(response.data || {});
    } catch (error) {
      throw normalizeChangesError(error);
    }
  }

  /** Единственная запись линии C — только по нажатию «Отметить просмотренным». */
  async markSeen(workspaceId: string, projectId: string, boardId: string): Promise<TPpmBoardSeen> {
    try {
      const response = await this.put(`${this.boardPath(workspaceId, projectId, boardId)}me/seen/`, {});
      return ppmBoardSeenSchema.parse(response.data || {});
    } catch (error) {
      throw normalizeChangesError(error);
    }
  }

  async getWorkItemBoards(
    workspaceId: string,
    projectId: string,
    workItemId: string
  ): Promise<{ results: TPpmWorkItemBoard[] }> {
    try {
      const response = await this.get(
        `${this.projectPath(workspaceId, projectId)}/canvas/work-items/${workItemId}/boards/`
      );
      return ppmWorkItemBoardsResponseSchema.parse(response.data);
    } catch (error) {
      throw normalizeChangesError(error);
    }
  }

  private boardPath(workspaceId: string, projectId: string, boardId: string) {
    return `${this.projectPath(workspaceId, projectId)}/canvas/boards/${boardId}/`;
  }

  private projectPath(workspaceId: string, projectId: string) {
    return `/api/ppm/v1/workspaces/${workspaceId}/projects/${projectId}`;
  }
}

function normalizeChangesError(error: unknown): PpmCanvasServiceError {
  if (error instanceof PpmCanvasServiceError) return error;
  if (isAxiosError(error)) {
    const parsed = ppmCanvasErrorResponseSchema.safeParse(error.response?.data);
    if (parsed.success)
      return new PpmCanvasServiceError(parsed.data.error.message, {
        code: parsed.data.error.code,
        details: parsed.data.error.details,
        requestId: parsed.data.error.request_id,
        status: error.response?.status,
      });
    return new PpmCanvasServiceError("Canvas changes request failed.", { status: error.response?.status });
  }
  return new PpmCanvasServiceError(error instanceof Error ? error.message : "Canvas changes request failed.");
}
