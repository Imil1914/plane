/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { createContext } from "react";
import type { TPpmCanvasContentBinding } from "@ppm/canvas";
import type { TPpmCanvasShape } from "./shape";

// canvas-content-actions.ts — AF2.1 B: действия карточек содержимого. Отдельный контекст, чтобы не менять форму
// PpmWorkItemProjectionContext (волна 1). Реализации — блок «AF2.1 B» в editor.tsx; они сами ловят ошибки и
// сообщают о результате через notify, промисы не отклоняются.
export type TPpmCanvasContentActions = {
  canEdit: boolean;
  /** AF2.1 B6: «Сделать задачами» — задачи Plane по пунктам, карточки столбиком рядом с чек-листом. Каждый пункт,
   * ставший задачей, сразу передаётся в onConverted (id пункта → id задачи); ответ — все такие пункты. */
  convertChecklistItems: (
    anchor: TPpmCanvasShape,
    items: { id: string; text: string }[],
    onConverted: (itemId: string, workItemId: string) => void
  ) => Promise<Record<string, string>>;
  /** AF2.1 B3: «Новый документ» — создать страницу в «Документах» и положить живую карточку на холст. */
  createPage: () => Promise<void>;
  createPageFromNote: (anchor: TPpmCanvasShape, title: string, markdown: string) => Promise<void>;
  createTaskFromText: (anchor: TPpmCanvasShape, name: string) => Promise<void>;
  /** AF2.1 B5: «Скачать»: blob через API и имя из карточки; без ответа сервера — уведомление со ссылкой ?download=1 (RB9). */
  downloadFile: (binding: TPpmCanvasContentBinding) => Promise<void>;
  /** AF2.1 B3: HTML документа для превью карточки (кеш по id и версии внутри реализации); null — недоступно. */
  loadPageHtml: (pageId: string, sourceVersion: string | null) => Promise<string | null>;
  notify: (message: string) => void;
  /** AF2.1 B3: «Документ PPM» — открыть поиск существующих документов. */
  openPagePicker: () => void;
  /** AF2.1 B5: «Просмотр»: полноэкранный диалог (портал в body). */
  previewFile: (binding: TPpmCanvasContentBinding) => void;
  /** AF2.1 B5 (RB7): /pdf/ Хранилища по идентичности источника (UUID пространства, C6); null — не PDF Хранилища. */
  vaultPdfUrl: (binding: TPpmCanvasContentBinding) => string | null;
};

export const PpmCanvasContentActionsContext = createContext<TPpmCanvasContentActions>({
  canEdit: false,
  convertChecklistItems: async () => ({}),
  createPage: async () => undefined,
  createPageFromNote: async () => undefined,
  createTaskFromText: async () => undefined,
  downloadFile: async () => undefined,
  loadPageHtml: async () => null,
  notify: () => undefined,
  openPagePicker: () => undefined,
  previewFile: () => undefined,
  vaultPdfUrl: () => null,
});
