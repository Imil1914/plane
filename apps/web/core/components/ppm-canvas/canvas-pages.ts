/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { EPageAccess } from "@plane/types";
import type { TPage } from "@plane/types";
import type { TPpmCanvasPageSearchResponse } from "@/services/ppm-canvas.service";
import { fillCanvasTemplate, formatDueDate } from "./canvas-grammar";

// AF2.1 B3: «Документ PPM» — поиск существующих документов. Основной путь — поиск Холста (S): только видимые
// пользователю страницы проекта. Запасной — список Plane (свои + публичные) с фильтром по имени на клиенте.
// Production зовёт createStickyPageSearch (см. ниже) — она же и есть точка входа для одного запроса тоже
// (первый вызов «липкого» поиска ведёт себя как разовый: пробует сервер, при отказе — запасной путь).
// R-a (раунд 1): доска — общий объект, заголовок карточки попадает в общий снимок — предлагаем и кладём только
// публичные документы (сервер тоже фильтрует, но проверяем и на клиенте — на случай более старого сервера).
export const CANVAS_PAGE_SEARCH_LIMIT = 20;

export type TCanvasPageHit = { excerpt: string | null; id: string; title: string };

export type TCanvasPageSearchDeps = {
  listProjectPages: () => Promise<Partial<TPage>[]>;
  searchServer: (query: string) => Promise<TPpmCanvasPageSearchResponse>;
};

function filterServerResults(results: TPpmCanvasPageSearchResponse["results"]): TCanvasPageHit[] {
  return results
    .filter(
      (result) =>
        result.identity.entity_type === "page" &&
        result.display.source_status !== "deleted" &&
        result.page.access === "public"
    )
    .slice(0, CANVAS_PAGE_SEARCH_LIMIT)
    .map((result) => ({
      excerpt: result.display.excerpt,
      id: result.identity.entity_id,
      title: result.display.title,
    }));
}

/** Запасной путь: список Plane (свои + публичные), но кладём на холст только публичные (R-a) — приватная страница
 *  другого автора не должна оказаться заголовком на общей доске просто потому, что владелец её видит в списке. */
export function filterFallbackPages(query: string, pages: readonly Partial<TPage>[]): TCanvasPageHit[] {
  const needle = query.trim().toLocaleLowerCase("ru");
  return (
    pages
      .filter((page) => Boolean(page.id) && !page.archived_at && page.access === EPageAccess.PUBLIC)
      .map((page) => ({
        title: (page.name ?? "").trim(),
        id: page.id as string,
        updated: String(page.updated_at ?? ""),
      }))
      .filter((page) => !needle || page.title.toLocaleLowerCase("ru").includes(needle))
      // oxlint-disable-next-line unicorn/no-array-sort -- filter returns a fresh array (lib ES2022: no toSorted).
      .sort((left, right) => {
        const leftPrefix = left.title.toLocaleLowerCase("ru").startsWith(needle) ? 0 : 1;
        const rightPrefix = right.title.toLocaleLowerCase("ru").startsWith(needle) ? 0 : 1;
        return (
          leftPrefix - rightPrefix ||
          right.updated.localeCompare(left.updated) ||
          left.title.localeCompare(right.title, "ru")
        );
      })
      .slice(0, CANVAS_PAGE_SEARCH_LIMIT)
      .map(({ id, title }) => ({ excerpt: null, id, title }))
  );
}

// M3 (раунд 1): пока пикер открыт, сервер, однажды отказавший, больше не дёргаем на каждое нажатие клавиши —
// запоминаем отказ и список запасного пути (запрашиваем его один раз), дальше фильтруем уже полученный список.
// Единственная точка входа production (раунд 2, пункт 5: убрал отдельную searchCanvasPages — она нигде, кроме
// тестов, не вызывалась; её поведение на один запрос — это и есть первый вызов результата этой фабрики).
export type TCanvasPageStickySearch = (
  query: string
) => Promise<{ hits: TCanvasPageHit[]; source: "fallback" | "server" }>;

export function createStickyPageSearch(deps: TCanvasPageSearchDeps): TCanvasPageStickySearch {
  let serverDown = false;
  // M4: держим уже полученный список (не промис) — отказ listProjectPages не кешируется, «Повторить» пробует
  // заново; успешный список запрашивается один раз за сессию пикера, а не на каждое нажатие клавиши.
  let fallbackPages: Partial<TPage>[] | undefined;
  // Пункт 7 (раунд 2): пока список не пришёл, конкурентные вызовы (два нажатия клавиши подряд, пока первый ответ
  // ещё не пришёл) ждут ОДИН и тот же промис, а не запускают второй параллельный запрос списка.
  let fallbackRequest: Promise<Partial<TPage>[]> | undefined;
  return async (query: string) => {
    const trimmed = query.trim();
    if (!serverDown) {
      try {
        const response = await deps.searchServer(trimmed);
        return { hits: filterServerResults(response.results), source: "server" as const };
      } catch {
        serverDown = true;
      }
    }
    if (fallbackPages === undefined) {
      if (!fallbackRequest) {
        fallbackRequest = deps.listProjectPages().catch((error: unknown) => {
          fallbackRequest = undefined; // M4: отказ не кешируем — следующий вызов (или «Повторить») пробует заново.
          throw error;
        });
      }
      fallbackPages = await fallbackRequest;
    }
    return { hits: filterFallbackPages(trimmed, fallbackPages), source: "fallback" as const };
  };
}

// Fix 1 (раунд 1): «Новый документ» без якоря-заметки (в отличие от noteSourceStep, canvas-placement.ts) — не
// более одной попытки создания в процессе (ref-замок в editor.tsx) и повтор после отказа кладёт уже созданную
// страницу вместо создания второй.
export type TUnplacedPageSource = { pageId: string; title: string };

export function pageCreateStep(
  unplaced: TUnplacedPageSource | undefined
): { step: "create" } | ({ step: "place" } & TUnplacedPageSource) {
  return unplaced ? { step: "place", ...unplaced } : { step: "create" };
}

// Fix 2 (раунд 1): доступ к документу отозван или он удалён между привязкой и отрисовкой — превью не грузим и не
// показываем; дата изменения тоже скрыта (нечего показывать в снимке, доступном только по памяти).
export function isPageContentReadable(sourceStatus: string, canRead: boolean): boolean {
  return sourceStatus !== "deleted" && canRead;
}

/** У страниц source_version = updated_at (ISO) — показываем «изменён 24 сент.», а не «v2026-09-24T…».
 *  M7 (раунд 1): дата — по локальному календарю зрителя, а не по срезу строки UTC (иначе у вечерних правок по
 *  UTC дата на экране может отличаться от локального дня зрителя). Строгая проверка формата остаётся: мусор вроде
 *  «7» не должен просочиться в `new Date(...)` (в некоторых движках такая строка — не Invalid Date). */
export function formatPageUpdated(
  sourceVersion: string | null | undefined,
  locale: string,
  template: string
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(sourceVersion ?? "")) return null;
  const parsed = new Date(sourceVersion as string);
  if (Number.isNaN(parsed.getTime())) return null;
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return fillCanvasTemplate(template, { date: formatDueDate(`${year}-${month}-${day}`, locale) });
}
