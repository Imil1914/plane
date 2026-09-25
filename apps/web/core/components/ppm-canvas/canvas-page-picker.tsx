/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { FileText, LoaderCircle, Search, X } from "lucide-react";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { createStickyPageSearch, type TCanvasPageHit, type TCanvasPageSearchDeps } from "./canvas-pages";

// AF2.1 B3: «Документ PPM» — поиск существующих документов. Порталом в body: внутри редактора остаётся ровно один
// [role="dialog"] (предпросмотр импорта, e2e-якорь).
// Fix 5 (раунд 1): клавиши не должны уходить на холст — фокус ловится внутри диалога (Tab по кругу), Escape
// закрывает из любого места внутри; блюр/фокус самого tldraw-редактора включает вызывающая сторона (editor.tsx).
const FOCUSABLE_SELECTOR = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function PpmCanvasPagePicker({
  deps,
  onClose,
  onPick,
}: {
  deps: TCanvasPageSearchDeps;
  onClose: () => void;
  onPick: (hit: TCanvasPageHit) => Promise<void>;
}) {
  const ppmT = usePpmTranslation();
  // M3: один «липкий» поиск на всё время жизни пикера — однажды отказавший сервер не дёргаем на каждое нажатие.
  const search = useMemo(() => createStickyPageSearch(deps), [deps]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<TCanvasPageHit[]>([]);
  const [source, setSource] = useState<"fallback" | "server">("server");
  const [loading, setLoading] = useState(true);
  // M4: ошибка — не то же самое, что «ничего не найдено».
  const [searchError, setSearchError] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const [placing, setPlacing] = useState<string>();
  const [activeIndex, setActiveIndex] = useState(0);
  const requestRef = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const request = ++requestRef.current;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void search(query)
        .then((result) => {
          if (request !== requestRef.current) return undefined;
          setHits(result.hits);
          setSource(result.source);
          setSearchError(false);
          setActiveIndex(0);
          return undefined;
        })
        .catch(() => {
          if (request !== requestRef.current) return;
          setHits([]);
          setSearchError(true);
        })
        .finally(() => {
          if (request === requestRef.current) setLoading(false);
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, retryToken, search]);

  // Fix 5: фокус — сразу в поле поиска (диалог открыт командой рейки, а не кликом по полю).
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const pick = async (hit: TCanvasPageHit) => {
    if (placing) return;
    setPlacing(hit.id);
    try {
      await onPick(hit);
      onClose();
    } catch {
      // M4: placeExistingPage бросает при отказе — уведомление уже показано (editor.tsx), диалог остаётся открыт.
    } finally {
      setPlacing(undefined);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.code === "Escape") {
      onClose();
      return;
    }
    if (event.code === "Tab") {
      const dialog = dialogRef.current;
      const focusable = dialog?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (!dialog || !focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      // (раунд 2, пункт 4): фокус мог остаться на самом диалоге (tabIndex={-1}) — Shift+Tab тогда тоже уводит на
      // последний фокусируемый элемент, а не проваливается в обычный порядок табуляции страницы.
      if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || active === dialog)) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    // M5: стрелки двигают подсветку списка (семантика listbox), поле поиска остаётся в фокусе.
    if (event.code === "ArrowDown" && hits.length > 0) {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % hits.length);
      return;
    }
    if (event.code === "ArrowUp" && hits.length > 0) {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + hits.length) % hits.length);
      return;
    }
    // Fix 4 (раунд 2, пункт 2): Enter/NumpadEnter выбирают активный результат только из поля поиска — иначе Enter
    // на «×» тоже выбрал бы документ вместо закрытия диалога, а у кнопок результата уже есть свой клик/Enter.
    if (
      (event.code === "Enter" || event.code === "NumpadEnter") &&
      event.target === inputRef.current &&
      !loading &&
      hits[activeIndex]
    ) {
      event.preventDefault();
      void pick(hits[activeIndex]);
    }
  };

  return createPortal(
    <div className="ppm-canvas-content-backdrop" role="presentation" onPointerDown={onClose}>
      <div
        ref={dialogRef}
        aria-label={ppmT("canvas.page_pick_title")}
        aria-modal="true"
        className="ppm-canvas-page-picker"
        // (раунд 2, пункт 1): маркер именно наших диалогов-порталов — workspace.tsx's модальный гард (R-b) ищет
        // этот атрибут, а не общий aria-modal, чтобы не глушить Plane's/R's собственные модалки (палитра команд,
        // панель досок, диалоги переименования/архива — у них тот же aria-modal="true", но не этот атрибут).
        data-ppm-canvas-modal=""
        role="dialog"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header>
          <strong>{ppmT("canvas.page_pick_title")}</strong>
          <button type="button" aria-label={ppmT("canvas.close")} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <label className="ppm-canvas-page-picker__search">
          <Search aria-hidden="true" />
          <input
            ref={inputRef}
            aria-activedescendant={hits[activeIndex] ? `ppm-page-option-${hits[activeIndex].id}` : undefined}
            aria-autocomplete="list"
            aria-controls="ppm-page-picker-listbox"
            aria-label={ppmT("canvas.page_search_placeholder")}
            placeholder={ppmT("canvas.page_search_placeholder")}
            role="combobox"
            aria-expanded={hits.length > 0}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          {loading && <LoaderCircle aria-hidden="true" className="ppm-canvas-page-picker__spinner" />}
        </label>
        {source === "fallback" && !searchError && <small>{ppmT("canvas.page_search_fallback")}</small>}
        <ul id="ppm-page-picker-listbox" role="listbox" aria-label={ppmT("canvas.page_pick_title")}>
          {hits.map((hit, index) => (
            <li key={hit.id} aria-selected={index === activeIndex} id={`ppm-page-option-${hit.id}`} role="option">
              <button
                type="button"
                disabled={Boolean(placing)}
                onClick={() => void pick(hit)}
                onFocus={() => setActiveIndex(index)}
                onPointerEnter={() => setActiveIndex(index)}
              >
                <FileText aria-hidden="true" />
                <span>
                  <strong>{hit.title || ppmT("canvas.page_untitled")}</strong>
                  {hit.excerpt && <small>{hit.excerpt}</small>}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {!loading && searchError && (
          <p className="ppm-canvas-page-picker__error">
            {ppmT("canvas.page_search_error")}
            <button type="button" onClick={() => setRetryToken((token) => token + 1)}>
              {ppmT("canvas.page_search_retry")}
            </button>
          </p>
        )}
        {!loading && !searchError && hits.length === 0 && <p>{ppmT("canvas.page_search_empty")}</p>}
      </div>
    </div>,
    window.document.body
  );
}
