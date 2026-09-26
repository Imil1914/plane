/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { isAxiosError } from "axios";
import { z } from "zod";
import { API_BASE_URL } from "@plane/constants";
import {
  ppmCanvasBindingMutationResponseSchema,
  ppmCanvasErrorResponseSchema,
  type TPpmCanvasBindingCreateRequest,
} from "@ppm/canvas";
import type { TLivingMapLoaders } from "@/components/ppm-canvas/living-map/map-data";
import {
  mapCycleSchema,
  mapIssueSchema,
  mapModuleSchema,
  mapPullRequestSchema,
  parseMapList,
  type TMapCycle,
  type TMapIssue,
  type TMapModule,
  type TMapPullRequest,
} from "@/components/ppm-canvas/living-map/map-model";
import { APIService } from "@/services/api.service";

// AF2.2 M: данные «Живой карты». Пакетная привязка S1 и чтение Plane одним запросом на вид: задачи со связями
// (issues-detail + expand=issue_relation, фильтр cycle — задачи спринта), спринт, направления, Git-связи проекта.
// Без N+1; только API PPM и Plane.

/** S1 принимает до 200 пунктов, столько же активирует одно сохранение доски (линия S). Вызывающие режут сами. */
export const PPM_CANVAS_BATCH_LIMIT = 200;
/** Предел страницы issues-detail (plane/utils/paginator.py MAX_LIMIT). */
export const MAP_ISSUES_PAGE_SIZE = 1000;

/** Пункт S1. client_operation_id не передаём: сервер выводит его из доски, фигуры и источника — повтор идемпотентен. */
export type TPpmCanvasBatchBindingItem = {
  entity_id: string;
  entity_type: TPpmCanvasBindingCreateRequest["entity_type"];
  shape_id: string;
};

const ppmCanvasBatchBindingResultSchema = z.discriminatedUnion("status", [
  z.object({ binding: ppmCanvasBindingMutationResponseSchema, shape_id: z.string(), status: z.literal("created") }),
  z.object({
    error: z.object({ code: z.string(), message: z.string() }).passthrough(),
    shape_id: z.string().nullable(),
    status: z.literal("error"),
  }),
]);
const ppmCanvasBatchBindingResponseSchema = z.object({ results: z.array(ppmCanvasBatchBindingResultSchema) });
export type TPpmCanvasBatchBindingResult = z.infer<typeof ppmCanvasBatchBindingResultSchema>;

function batchFailure(error: unknown): { code: string; message: string } {
  const parsed = isAxiosError(error) ? ppmCanvasErrorResponseSchema.safeParse(error.response?.data) : undefined;
  if (parsed?.success) return { code: parsed.data.error.code, message: parsed.data.error.message };
  return { code: "CANVAS_BATCH_FAILED", message: error instanceof Error ? error.message : "Canvas request failed." };
}

export class PpmCanvasMapService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  /** S1: один запрос; ответ — по пункту в порядке входа. Отказ запроса (сеть, 403, 400) — ошибка у каждого пункта. */
  async bindBatch(
    workspaceId: string,
    projectId: string,
    boardId: string,
    items: readonly TPpmCanvasBatchBindingItem[]
  ): Promise<TPpmCanvasBatchBindingResult[]> {
    if (items.length === 0) return [];
    try {
      const response = await this.post(
        `/api/ppm/v1/workspaces/${workspaceId}/projects/${projectId}/canvas/boards/${boardId}/bindings/batch/`,
        { items }
      );
      const { results } = ppmCanvasBatchBindingResponseSchema.parse(response.data);
      return items.map(
        (item, index): TPpmCanvasBatchBindingResult =>
          results[index] ?? {
            error: { code: "CANVAS_BATCH_MISSING", message: "No result for this item." },
            shape_id: item.shape_id,
            status: "error",
          }
      );
    } catch (error) {
      const failure = batchFailure(error);
      return items.map(
        (item): TPpmCanvasBatchBindingResult => ({ error: failure, shape_id: item.shape_id, status: "error" })
      );
    }
  }

  /** Спринты проекта без архивных — выбор в диалоге «Карта спринта». */
  async getCycles(workspaceSlug: string, projectId: string): Promise<TMapCycle[]> {
    const response = await this.get(`/api/workspaces/${workspaceSlug}/projects/${projectId}/cycles/`);
    return parseMapList(mapCycleSchema, response.data).filter((item) => !item.archived_at);
  }

  /** Спринт рамки; удалён, в архиве или недоступен — null («спринт недоступен»); сбой сети — ошибка. */
  async getCycle(workspaceSlug: string, projectId: string, cycleId: string): Promise<TMapCycle | null> {
    try {
      const response = await this.get(`/api/workspaces/${workspaceSlug}/projects/${projectId}/cycles/${cycleId}/`);
      const parsed = mapCycleSchema.safeParse(response.data);
      return parsed.success && !parsed.data.archived_at ? parsed.data : null;
    } catch (error) {
      if (isAxiosError(error) && (error.response?.status === 403 || error.response?.status === 404)) return null;
      throw error;
    }
  }

  /**
   * Направления проекта без архивных. Выключены или недоступны (403/404) — пусто: карта одной секцией «Без
   * направления»; сбой сети — ошибка (сборка карты покажет «Повторить», ревью M1, раунд 1).
   */
  async getModules(workspaceSlug: string, projectId: string): Promise<TMapModule[]> {
    try {
      const response = await this.get(`/api/workspaces/${workspaceSlug}/projects/${projectId}/modules/`);
      return parseMapList(mapModuleSchema, response.data).filter((direction) => !direction.archived_at);
    } catch (error) {
      if (isAxiosError(error) && (error.response?.status === 403 || error.response?.status === 404)) return [];
      throw error;
    }
  }

  /** Задачи со связями одним запросом; cycleId — только задачи этого спринта. Видимость — как в «Задачах». */
  async getIssues(workspaceSlug: string, projectId: string, cycleId?: string): Promise<TMapIssue[]> {
    const response = await this.get(`/api/workspaces/${workspaceSlug}/projects/${projectId}/issues-detail/`, {
      params: {
        ...(cycleId ? { cycle: cycleId } : {}),
        expand: "issue_relation",
        order_by: "-updated_at",
        per_page: MAP_ISSUES_PAGE_SIZE,
      },
    });
    return parseMapList(mapIssueSchema, (response.data as { results?: unknown } | undefined)?.results);
  }

  /** Git-связи проекта (PR задач); Git не подключён или нет прав — пусто, лоток без PR. */
  async getPullRequests(workspaceId: string, projectId: string): Promise<TMapPullRequest[]> {
    try {
      const response = await this.get(`/api/ppm/v1/workspaces/${workspaceId}/projects/${projectId}/git/links/`);
      return parseMapList(mapPullRequestSchema, (response.data as { links?: unknown } | undefined)?.links);
    } catch {
      return [];
    }
  }
}

/** Загрузчики фактов карты одной доски (living-map-facts.ts). */
export function createLivingMapLoaders(
  service: PpmCanvasMapService,
  scope: { projectId: string; workspaceId: string; workspaceSlug: string }
): TLivingMapLoaders {
  return {
    cycle: (cycleId) => service.getCycle(scope.workspaceSlug, scope.projectId, cycleId),
    modules: () => service.getModules(scope.workspaceSlug, scope.projectId),
    projectIssues: () => service.getIssues(scope.workspaceSlug, scope.projectId),
    pullRequests: () => service.getPullRequests(scope.workspaceId, scope.projectId),
    sprintIssues: (cycleId) => service.getIssues(scope.workspaceSlug, scope.projectId, cycleId),
  };
}
