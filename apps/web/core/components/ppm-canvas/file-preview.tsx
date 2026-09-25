/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Download, FileText, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useTheme } from "next-themes";
import type { Editor } from "tldraw";
import type { TPpmTranslationKey } from "@ppm/brand";
import type { TPpmCanvasContentBinding } from "@ppm/canvas";
import { resolveGeneralTheme } from "@plane/utils";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import type { TPpmVaultPreview, TPpmVaultRequestOptions } from "@/services/ppm-vault.service";
import { highlightCodeLines, languageForFileName, type TCodeSegment } from "./canvas-code";
import {
  capPreviewText,
  filePreviewKind,
  filePreviewUnsupportedKey,
  isRetryablePreviewError,
  isVaultGoneError,
  isVaultNetworkError,
  parseCsvPreview,
  type TFilePreviewKind,
} from "./canvas-file-kind";
import { fillCanvasTemplate } from "./canvas-grammar";
import { canvasMarkdownPlainReason, renderCanvasMarkdown, sanitizeCanvasHtml } from "./canvas-markdown";

// AF2.1 B5 (K4): полноэкранный просмотр файловой карточки. Картинка и PDF Хранилища — по ссылкам (браузер грузит сам);
// текст/CSV/JSON/код — текстом с подсветкой; Markdown — как заметка; Office — превью, построенное сервером (S).
// Всё HTML — через sanitizeCanvasHtml (DOMPurify). Содержимое живёт только в состоянии диалога: в доску не пишется.

/** Что нужно просмотру от PpmVaultService (форма, а не класс: тесты подставляют свою). */
export type TFilePreviewVault = {
  fileUrl: (workspaceId: string, projectId: string, entryId: string) => string;
  getFileBlob: (
    workspaceId: string,
    projectId: string,
    entryId: string,
    options?: TPpmVaultRequestOptions
  ) => Promise<Blob>;
  getFileText: (
    workspaceId: string,
    projectId: string,
    entryId: string,
    options?: TPpmVaultRequestOptions
  ) => Promise<string>;
  getMarkdown: (
    workspaceId: string,
    projectId: string,
    entryId: string,
    options?: TPpmVaultRequestOptions
  ) => Promise<{ content: string }>;
  getPreview: (
    workspaceId: string,
    projectId: string,
    entryId: string,
    options?: TPpmVaultRequestOptions
  ) => Promise<TPpmVaultPreview>;
  pdfUrl: (workspaceId: string, projectId: string, entryId: string) => string;
};

export type TFilePreviewState =
  | { status: "error" }
  | { status: "gone" }
  | { status: "loading" }
  | { status: "media" }
  | { preview: TPpmVaultPreview; status: "ready" }
  | { status: "retry" }
  | { reason?: string; status: "unsupported" }
  | { status: "text"; text: string; truncated: boolean };

/** Длиннее — текст без нумерации строк одним узлом: 1 МиБ не превращается в десятки тысяч элементов. */
const NUMBERED_TEXT_MAX_CHARS = 200_000;

function entryIds(binding: TPpmCanvasContentBinding) {
  const { identity } = binding.source;
  return [identity.workspace_id, identity.project_id, binding.entity_id] as const;
}

/**
 * RB7: PDF Хранилища — /pdf/ по идентичности источника (UUID пространства, C6), а не из сырого preview_url: сервер
 * проверил сигнатуру %PDF-, отдаёт application/pdf и nosniff, поэтому фрейм без песочницы. Иначе — null.
 */
export function vaultPdfUrl(
  binding: TPpmCanvasContentBinding,
  vault: Pick<TFilePreviewVault, "pdfUrl">
): string | null {
  const { display } = binding.source;
  if (binding.entity_type !== "vault_file" || filePreviewKind(display.extension, display.mime_type) !== "pdf")
    return null;
  return vault.pdfUrl(...entryIds(binding));
}

/** Ссылка для картинки и PDF. PDF — только Хранилища (vaultPdfUrl): вложения задач без песочницы не открываем. */
export function filePreviewMediaUrl(
  binding: TPpmCanvasContentBinding,
  vault: Pick<TFilePreviewVault, "fileUrl" | "pdfUrl">
): string | null {
  const { display } = binding.source;
  if (filePreviewKind(display.extension, display.mime_type) === "image")
    return binding.entity_type === "vault_file" ? vault.fileUrl(...entryIds(binding)) : display.preview_url;
  return vaultPdfUrl(binding, vault);
}

/** Текст ≤ 1 МиБ в байтах UTF-8; пометка «показано начало» — если резал сервер или клиент. */
function textState(text: string, truncated: boolean): TFilePreviewState {
  const capped = capPreviewText(text);
  return { status: "text", text: capped.text, truncated: truncated || capped.truncated };
}

/**
 * Содержимое просмотра. Картинки и PDF грузит браузер по ссылке («media»); остальное — запросы с отменой по `signal`:
 * превью сервера (S) → при его отсутствии (RB8: 404 без кода) Markdown-материал из /content/ → сам файл из /file/.
 * 403/404 VAULT_ENTRY_NOT_FOUND — «gone»; 503 VAULT_STORAGE_FAILED и обрыв сети — «retry»; отмена (диалог закрыт) —
 * исключение, запасные пути не стартуют.
 */
export async function loadFilePreview(
  binding: TPpmCanvasContentBinding,
  vault: TFilePreviewVault,
  signal: AbortSignal
): Promise<TFilePreviewState> {
  const { display } = binding.source;
  const kind = filePreviewKind(display.extension, display.mime_type);
  if (kind === "image" || kind === "pdf")
    return filePreviewMediaUrl(binding, vault) ? { status: "media" } : { status: "unsupported" };
  if (binding.entity_type !== "vault_file" || kind === "download") return { status: "unsupported" };
  const ids = entryIds(binding);
  try {
    const preview = await vault.getPreview(...ids, { signal });
    if (preview.kind === "unsupported")
      return preview.reason ? { reason: preview.reason, status: "unsupported" } : { status: "unsupported" };
    if (kind === "office") return preview.kind === "text" ? { status: "unsupported" } : { preview, status: "ready" };
    if (preview.kind === "text" && typeof preview.text === "string") return textState(preview.text, preview.truncated);
    return { status: "unsupported" };
  } catch (error) {
    if (signal.aborted) throw error;
    if (isVaultGoneError(error)) return { status: "gone" };
    if (isRetryablePreviewError(error)) return { status: "retry" };
    // Office без превью сервера не прочитать; текст — запасным путём ниже.
    if (kind === "office") return { status: "unsupported" };
  }
  try {
    if (kind === "markdown") {
      try {
        const markdown = await vault.getMarkdown(...ids, { signal });
        return textState(markdown.content, false);
      } catch (error) {
        if (signal.aborted) throw error;
        // Вставленный .md — обычный файл Хранилища: /content/ у него нет (404), текст — из /file/.
      }
    }
    return textState(await vault.getFileText(...ids, { signal }), false);
  } catch (error) {
    if (signal.aborted) throw error;
    if (isVaultGoneError(error)) return { status: "gone" };
    return (error as { status?: unknown } | null)?.status === 503 ? { status: "retry" } : { status: "error" };
  }
}

/** «Скачать» файла Хранилища: сам файл; у Markdown-материала бинарного файла нет (400 VAULT_INVALID_FILE_TYPE) — /content/. */
export async function loadVaultFileBlob(
  binding: TPpmCanvasContentBinding,
  vault: Pick<TFilePreviewVault, "getFileBlob" | "getMarkdown">
): Promise<Blob> {
  const ids = entryIds(binding);
  try {
    return await vault.getFileBlob(...ids);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== "VAULT_INVALID_FILE_TYPE") throw error;
    const markdown = await vault.getMarkdown(...ids);
    return new Blob([markdown.content], { type: "text/markdown;charset=utf-8" });
  }
}

/** Сохраняет blob под именем файла: ссылка blob: того же источника — браузер скачивает, холст остаётся на месте. */
export function saveCanvasBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.click();
  // Не сразу: часть браузеров читает blob уже после click().
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export type TFileDownloadVault = Pick<TFilePreviewVault, "getFileBlob" | "getMarkdown"> & {
  downloadUrl: (workspaceId: string, projectId: string, entryId: string) => string;
};

export type TCanvasDownloadResult = { status: "error" } | { status: "link"; url: string } | { status: "started" };

/** Уведомление холста (блок B): текст или текст со ссылкой-действием (RB9: «Скачать» по ссылке ?download=1). */
export type TCanvasContentNotice = string | { href: string; label: string; text: string };

/** Финальная волна (M-1): почему Markdown-файл показан без форматирования — та же причина, что у карточки заметки. */
export function markdownPreviewPlainKey(
  text: string
): "canvas.file_preview_plain_complex" | "canvas.file_preview_plain_long" | undefined {
  const reason = canvasMarkdownPlainReason(text);
  if (reason === "length") return "canvas.file_preview_plain_long";
  if (reason === "complexity") return "canvas.file_preview_plain_complex";
  return undefined;
}

export type TFilePreviewDownloadNotice = { href?: string; label?: string; text: string; tone: "error" | "info" };

/**
 * Финальная волна (отложенное B5): исход «Скачать» внутри просмотра — в самом диалоге. Уведомление холста рисуется
 * под модальным окном и не видно; ссылку ?download=1 (S3 без CORS) щёлкает сам пользователь. «started» — молчим.
 */
export function filePreviewDownloadNotice(
  result: TCanvasDownloadResult | undefined,
  name: string,
  t: (key: TPpmTranslationKey) => string
): TFilePreviewDownloadNotice | undefined {
  if (result?.status === "error") return { text: t("canvas.file_download_error"), tone: "error" };
  if (result?.status === "link")
    return {
      href: result.url,
      label: t("canvas.file_download"),
      text: fillCanvasTemplate(t("canvas.file_download_link"), { name }),
      tone: "info",
    };
  return undefined;
}

/**
 * «Скачать» (RB9), холст не покидаем никогда. Файл Хранилища — blob через API под именем из карточки; без ответа
 * сервера (S3: CORS подписанной ссылки) — «link»: ссылку ?download=1 (настоящее имя от сервера) пользователь щёлкает
 * сам в уведомлении (window.open после await браузер счёл бы всплывающим окном); ответ с ошибкой — «error».
 * Вложение задачи — его ссылка в новой вкладке, синхронно в том же щелчке.
 */
export async function downloadCanvasFile(
  binding: TPpmCanvasContentBinding,
  vault: TFileDownloadVault
): Promise<TCanvasDownloadResult> {
  const { display, identity } = binding.source;
  if (binding.entity_type !== "vault_file") {
    const url = display.preview_url ?? identity.source_url;
    if (!url) return { status: "error" };
    window.open(url, "_blank", "noopener");
    return { status: "started" };
  }
  try {
    saveCanvasBlob(await loadVaultFileBlob(binding, vault), display.title || `file${display.extension ?? ""}`);
    return { status: "started" };
  } catch (error) {
    return isVaultNetworkError(error)
      ? { status: "link", url: vault.downloadUrl(...entryIds(binding)) }
      : { status: "error" };
  }
}

export type TCanvasEditorFocusState = {
  /** Вкладка этой доски активна (workspace.tsx держит смонтированными редакторы всех открытых вкладок). */
  isActive: boolean;
  /** Открыт диалог холста (выбор документа, выбор файла Хранилища, просмотр файла). */
  modalOpen: boolean;
};

/**
 * Одно решение на все причины. Редактор «в фокусе» только на активной вкладке и без открытого диалога холста: tldraw
 * 3.15.6 вешает вставку/копирование (document) и горячие клавиши (hotkeys-js на body) на КАЖДЫЙ редактор «в фокусе» —
 * иначе одна ⌘V попадает на все открытые доски, а ⌘Z, Delete и буквы инструментов — ещё и на скрытые.
 */
export function shouldFocusCanvasEditor({ isActive, modalOpen }: TCanvasEditorFocusState): boolean {
  return isActive && !modalOpen;
}

/**
 * DOM-фокус «потерян» — отнимать его не у кого: активного элемента нет или это body; он внутри скрытой панели
 * ([aria-hidden="true"] — вкладка другой доски); он в контейнере ДРУГОГО редактора tldraw (.tl-container скрытой
 * вкладки). Safari не фокусирует кнопку вкладки по щелчку, и после смены вкладки фокус остаётся в холсте прежней доски —
 * без этого стрелки, Esc и пробел (панорама) новой доски молчали бы до первого щелчка, а исход зависел бы от порядка
 * вкладок (чей эффект раньше: blur прежней или focus новой).
 */
export function isCanvasDomFocusLost(activeElement: Element | null, ownContainer: Element | null): boolean {
  if (!activeElement || activeElement === activeElement.ownerDocument?.body) return true;
  if (activeElement.closest('[aria-hidden="true"]')) return true;
  const container = activeElement.closest(".tl-container");
  return container !== null && container !== ownContainer;
}

/**
 * Горячие клавиши tldraw (hotkeys-js на document.body: Backspace/Delete, ⌘Z, буквы инструментов) работают, пока
 * редактор «в фокусе», — даже когда фокус в диалоге-портале или редактор на скрытой вкладке. Пока открыт диалог холста
 * или вкладка скрыта, редактор выключаем (blur); иначе включаем. Фокус, который уже на своём месте (кнопка вкладки,
 * кнопка «Просмотр» на карточке, кнопка рейки…), не отнимаем; если фокус потерян (isCanvasDomFocusLost) — контейнер
 * холста: стрелки и Esc tldraw слушает на нём. Контейнер скрытой вкладки фокус не получает никогда.
 */
export function syncCanvasEditorFocus(
  editor: Pick<Editor, "blur" | "focus" | "getContainer">,
  state: TCanvasEditorFocusState,
  activeElement: Element | null = typeof document === "undefined" ? null : document.activeElement
) {
  if (!shouldFocusCanvasEditor(state)) {
    editor.blur();
    return;
  }
  editor.focus({ focusContainer: isCanvasDomFocusLost(activeElement, editor.getContainer()) });
}

// ── «На холст» со страниц Хранилища и кода: ссылка (?ppm_vault_* / ?ppm_git_*) забирается из адреса один раз ──

/** Все параметры ссылок «На холст»: ppm-vault/route.tsx (canvasProjectionHref) и ppm-git/route.tsx. */
export const PPM_CANVAS_VAULT_LINK_PARAMS = [
  "ppm_vault_entry",
  "ppm_vault_extension",
  "ppm_vault_title",
  "ppm_vault_url",
  "ppm_vault_version",
] as const;
export const PPM_CANVAS_GIT_LINK_PARAMS = [
  "ppm_git_id",
  "ppm_git_provider",
  "ppm_git_repository",
  "ppm_git_title",
  "ppm_git_type",
  "ppm_git_url",
  "ppm_git_work_item",
] as const;

/**
 * Забирает ссылку «На холст» из строки запроса: значения её параметров — вызывающему, строка запроса — без них (прочие,
 * например board, остаются; пустая — ""). Редактор переписывает адрес этой строкой синхронно, ДО первого await: чтение и
 * удаление атомарны, поэтому ни повтор эффекта (смена вкладки, статуса сохранения), ни редактор другой вкладки ссылку
 * уже не увидят — второй привязки и второй карточки не будет.
 */
export function takeCanvasLinkParams<TKey extends string>(
  search: string,
  keys: readonly TKey[]
): { search: string; values: Partial<Record<TKey, string>> } {
  const parameters = new URLSearchParams(search);
  const values: Partial<Record<TKey, string>> = {};
  for (const key of keys) {
    const value = parameters.get(key);
    if (value !== null) values[key] = value;
    parameters.delete(key);
  }
  const rest = parameters.toString();
  return { search: rest ? `?${rest}` : "", values };
}

/** (B5) Событие перетаскивания из диалога-портала холста: в DOM он вне оболочки, но React-всплытие идёт по дереву редактора. */
export function isFromCanvasModal(shell: Pick<Node, "contains">, target: EventTarget | null): boolean {
  if (!target) return false;
  const node = target as Node & { closest?: (selector: string) => Element | null };
  return !shell.contains(node) || Boolean(node.closest?.("[data-ppm-canvas-modal]"));
}

/** Вкладки листов: ←/→ по кругу, Home/End — к краям (e.code); прочие клавиши — undefined. */
export function nextSheetIndex(code: string, index: number, count: number): number | undefined {
  if (count <= 0) return undefined;
  if (code === "ArrowRight") return (index + 1) % count;
  if (code === "ArrowLeft") return (index - 1 + count) % count;
  if (code === "Home") return 0;
  if (code === "End") return count - 1;
  return undefined;
}

const FOCUSABLE = 'a[href], button:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';

function focusableItems(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => element.tabIndex >= 0 && !element.hasAttribute("data-ppm-focus-guard")
  );
}

function blockDrop(event: DragEvent<HTMLElement>) {
  // Поверх просмотра ничего не бросают: ни на холст под ним, ни браузеру (он открыл бы файл или ссылку вместо холста).
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = "none";
}

export function PpmFilePreviewDialog({
  binding,
  onClose,
  onDownload,
  vaultService,
}: {
  binding: TPpmCanvasContentBinding;
  onClose: () => void;
  onDownload: (binding: TPpmCanvasContentBinding) => Promise<TCanvasDownloadResult>;
  vaultService: TFilePreviewVault;
}) {
  const ppmT = usePpmTranslation();
  const { resolvedTheme } = useTheme();
  const { display, identity } = binding.source;
  const isVault = binding.entity_type === "vault_file";
  const kind = filePreviewKind(display.extension, display.mime_type);
  const mediaUrl = filePreviewMediaUrl(binding, vaultService);
  const [state, setState] = useState<TFilePreviewState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // Финальная волна (B5): исход «Скачать» живёт в диалоге — ссылка или ошибка видны здесь, а не под модальным окном.
  const [download, setDownload] = useState<TCanvasDownloadResult>();
  const [downloading, setDownloading] = useState(false);
  const downloadingRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Фокус — в диалог при открытии и обратно (к кнопке «Просмотр» карточки) при закрытии.
  useEffect(() => {
    const previous = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  // Лениво: запросы идут, только пока диалог открыт; закрытие и «Повторить» прерывают прежний запрос.
  useEffect(() => {
    const controller = new AbortController();
    void loadFilePreview(binding, vaultService, controller.signal).then(
      (loaded) => {
        if (!controller.signal.aborted) setState(loaded);
        return undefined;
      },
      () => {
        if (!controller.signal.aborted) setState({ status: "error" });
      }
    );
    return () => controller.abort();
  }, [attempt, binding, vaultService]);

  const retry = () => {
    setState({ status: "loading" });
    setAttempt((current) => current + 1);
  };

  const runDownload = async () => {
    // Повторный щелчок во время скачивания ничего не начинает (ref: два щелчка до перерисовки видят одно и то же).
    if (downloadingRef.current) return;
    downloadingRef.current = true;
    setDownloading(true);
    setDownload(undefined);
    try {
      setDownload(await onDownload(binding));
    } catch {
      setDownload({ status: "error" });
    } finally {
      downloadingRef.current = false;
      setDownloading(false);
    }
  };
  const downloadNotice = filePreviewDownloadNotice(download, display.title, ppmT);

  const focusEdge = (edge: "first" | "last") => {
    const items = focusableItems(dialogRef.current);
    (edge === "first" ? items[0] : items[items.length - 1])?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Портал в body, но React-всплытие идёт по дереву редактора: клавиши диалога не доходят ни до холста, ни до tldraw.
    event.stopPropagation();
    if (event.code === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.code === "Tab") {
      // Ловушка фокуса: Tab с последнего элемента — на первый, Shift+Tab с первого — на последний.
      const items = focusableItems(dialogRef.current);
      const active = window.document.activeElement;
      const atStart = active === items[0] || active === dialogRef.current;
      const atEnd = active === items[items.length - 1] || active === dialogRef.current;
      if (items.length > 0 && (event.shiftKey ? atStart : atEnd)) {
        event.preventDefault();
        focusEdge(event.shiftKey ? "last" : "first");
      }
    }
  };

  const downloadButton = (
    // Не disabled во время скачивания: фокус ушёл бы в body, и Esc/Tab перестали бы доходить до диалога.
    <button
      type="button"
      aria-busy={downloading || undefined}
      className="ppm-file-preview__action"
      onClick={() => void runDownload()}
    >
      <Download aria-hidden="true" />
      {ppmT("canvas.file_download")}
    </button>
  );
  const retryButton = (
    <button type="button" className="ppm-file-preview__action" onClick={retry}>
      <RefreshCw aria-hidden="true" />
      {ppmT("vault.retry")}
    </button>
  );
  let body: ReactNode;
  if (state.status === "loading")
    body = (
      <p className="ppm-file-preview__message" role="status">
        <LoaderCircle aria-hidden="true" className="ppm-file-preview__spinner" />
        {ppmT("canvas.file_preview_loading")}
      </p>
    );
  else if (state.status === "retry")
    body = (
      <PreviewMessage text={ppmT("canvas.file_preview_busy")}>
        {retryButton}
        {downloadButton}
      </PreviewMessage>
    );
  else if (state.status === "gone") body = <PreviewMessage text={ppmT("canvas.file_preview_gone")} />;
  else if (state.status === "error")
    body = <PreviewMessage text={ppmT("canvas.file_preview_error")}>{downloadButton}</PreviewMessage>;
  else if (state.status === "unsupported")
    body = (
      // «limits» бывает и от бюджета времени сервера (занят) — повтор может помочь; размер файла — нет.
      <PreviewMessage text={ppmT(filePreviewUnsupportedKey(state.reason))}>
        {state.reason === "limits" && retryButton}
        {downloadButton}
      </PreviewMessage>
    );
  else if (state.status === "media" && mediaUrl)
    body =
      kind === "image" ? (
        <img
          alt={display.title}
          referrerPolicy="no-referrer"
          src={mediaUrl}
          onError={() => setState({ status: "error" })}
        />
      ) : (
        // RB7: сюда попадает только PDF Хранилища (/pdf/: сигнатура %PDF-, application/pdf + nosniff) — встроенный
        // просмотрщик в песочнице не работает; PDF вложений во фрейм не попадает (filePreviewMediaUrl → null).
        // oxlint-disable-next-line react/iframe-missing-sandbox -- RB7: только /pdf/ Хранилища, см. выше
        <iframe referrerPolicy="no-referrer" src={mediaUrl} title={display.title} />
      );
  else if (state.status === "text")
    body = (
      <PreviewText
        fileName={display.extension ? `file${display.extension}` : display.title}
        kind={kind}
        text={state.text}
        truncated={state.truncated}
      />
    );
  else if (state.status === "ready") body = <OfficePreview preview={state.preview} />;
  else body = <PreviewMessage text={ppmT("canvas.file_preview_unsupported")}>{downloadButton}</PreviewMessage>;

  const extensionLabel = display.extension?.replace(/^\./, "").toUpperCase();
  return createPortal(
    <div
      className="ppm-canvas-content-backdrop"
      role="presentation"
      onDragOver={blockDrop}
      onDrop={blockDrop}
      onPointerDown={onClose}
    >
      <div
        ref={dialogRef}
        aria-label={display.title}
        aria-modal="true"
        className="ppm-file-preview"
        data-code-theme={resolveGeneralTheme(resolvedTheme) === "dark" ? "dark" : "light"}
        data-download-notice={downloadNotice ? "" : undefined}
        data-kind={kind}
        data-ppm-canvas-modal=""
        role="dialog"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {/* Стражи фокуса: Tab из встроенного просмотрщика PDF (фрейм) возвращается в диалог, а не на холст. */}
        <span
          className="ppm-file-preview__guard"
          data-ppm-focus-guard="start"
          tabIndex={0}
          onFocus={() => focusEdge("last")}
        />
        <header className="ppm-file-preview__header">
          <div className="ppm-file-preview__title">
            <strong title={display.title}>{display.title}</strong>
            {extensionLabel && <span className="ppm-file-preview__type">{extensionLabel}</span>}
          </div>
          {downloadButton}
          {isVault && identity.source_url && (
            <a
              className="ppm-file-preview__action"
              href={identity.source_url}
              rel="noopener noreferrer"
              target="_blank"
            >
              {ppmT("canvas.file_open_in_vault")}
              <ArrowUpRight aria-hidden="true" />
            </a>
          )}
          <button
            ref={closeRef}
            type="button"
            aria-label={ppmT("canvas.close")}
            className="ppm-file-preview__close"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        {downloadNotice && (
          <p className="ppm-file-preview__download" data-tone={downloadNotice.tone} role="status">
            <span>{downloadNotice.text}</span>
            {downloadNotice.href && (
              <a
                download
                href={downloadNotice.href}
                rel="noopener noreferrer"
                target="_blank"
                onClick={() => window.setTimeout(() => setDownload(undefined), 0)}
              >
                {downloadNotice.label}
              </a>
            )}
          </p>
        )}
        <div className="ppm-file-preview__body" data-state={state.status}>
          {body}
        </div>
        <span
          className="ppm-file-preview__guard"
          data-ppm-focus-guard="end"
          tabIndex={0}
          onFocus={() => focusEdge("first")}
        />
      </div>
    </div>,
    window.document.body
  );
}

function PreviewMessage({ children, text }: { children?: ReactNode; text: string }) {
  return (
    <div className="ppm-file-preview__message">
      <FileText aria-hidden="true" />
      <p role="status">{text}</p>
      {children && <div className="ppm-file-preview__message-actions">{children}</div>}
    </div>
  );
}

function PreviewText({
  fileName,
  kind,
  text,
  truncated,
}: {
  fileName: string;
  kind: TFilePreviewKind;
  text: string;
  truncated: boolean;
}) {
  const ppmT = usePpmTranslation();
  const content = useMemo(() => {
    if (kind === "markdown")
      return {
        html: sanitizeCanvasHtml(renderCanvasMarkdown(text)),
        // M-1 (финальная волна): длинный или слишком сложный Markdown — текстом и с подписью о причине, как у заметки.
        plainKey: markdownPreviewPlainKey(text),
        type: "markdown" as const,
      };
    if (kind === "csv") return { ...parseCsvPreview(text), type: "table" as const };
    if (kind === "json") {
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // Обрезанный или неверный JSON — как есть.
      }
      return { language: "json", text: pretty, type: "code" as const };
    }
    return { language: kind === "code" ? languageForFileName(fileName) : "plaintext", text, type: "code" as const };
  }, [fileName, kind, text]);

  const notice =
    truncated || (content.type === "table" && content.truncated) ? (
      <small className="ppm-file-preview__note">{ppmT("canvas.file_preview_truncated")}</small>
    ) : null;
  if (content.type === "markdown")
    return (
      <>
        {content.plainKey && <small className="ppm-file-preview__note">{ppmT(content.plainKey)}</small>}
        <div
          className="ppm-file-preview__markdown"
          // oxlint-disable-next-line react/no-danger -- HTML прошёл sanitizeCanvasHtml (DOMPurify)
          dangerouslySetInnerHTML={{ __html: content.html }}
        />
        {notice}
      </>
    );
  if (content.type === "table")
    return (
      <>
        <PreviewTable rows={content.rows} />
        {notice}
      </>
    );
  return (
    <>
      <PreviewCode language={content.language} text={content.text} />
      {notice}
    </>
  );
}

function OfficePreview({ preview }: { preview: TPpmVaultPreview }) {
  const ppmT = usePpmTranslation();
  const [sheetIndex, setSheetIndex] = useState(0);
  const tabsId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // HTML сервера (nh3) повторно проходит DOMPurify в строгом режиме: без style, SVG, MathML, id/name.
  const documentHtml = useMemo(
    () => (preview.html ? sanitizeCanvasHtml(preview.html, { allowKatex: false }) : ""),
    [preview.html]
  );
  const truncated = preview.truncated ? (
    <small className="ppm-file-preview__note">{ppmT("canvas.file_preview_truncated")}</small>
  ) : null;

  if (preview.kind === "docx" && documentHtml)
    return (
      <>
        <div
          className="ppm-file-preview__document"
          // oxlint-disable-next-line react/no-danger -- HTML сервера (nh3) повторно прошёл sanitizeCanvasHtml (DOMPurify)
          dangerouslySetInnerHTML={{ __html: documentHtml }}
        />
        {truncated}
      </>
    );
  if (preview.kind === "xlsx" && preview.sheets?.length) {
    const { sheets } = preview;
    const current = Math.min(sheetIndex, sheets.length - 1);
    const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      const next = nextSheetIndex(event.code, index, sheets.length);
      if (next === undefined) return;
      event.preventDefault();
      setSheetIndex(next);
      tabRefs.current[next]?.focus();
    };
    return (
      <>
        <div className="ppm-file-preview__tabs" role="tablist">
          {sheets.map((sheet, index) => (
            <button
              aria-controls={`${tabsId}-panel`}
              aria-selected={index === current}
              id={`${tabsId}-tab-${index}`}
              // Имена листов в книге уникальны (Excel не даёт двух одинаковых).
              key={sheet.name}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              role="tab"
              tabIndex={index === current ? 0 : -1}
              type="button"
              onClick={() => setSheetIndex(index)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
            >
              {sheet.name}
            </button>
          ))}
        </div>
        <div aria-labelledby={`${tabsId}-tab-${current}`} id={`${tabsId}-panel`} role="tabpanel" tabIndex={0}>
          <PreviewTable rows={sheets[current].rows} />
        </div>
        <small className="ppm-file-preview__note">{ppmT("canvas.file_preview_values_only")}</small>
        {truncated}
      </>
    );
  }
  if (preview.kind === "pptx" && preview.slides?.length)
    return (
      <>
        <ol className="ppm-file-preview__slides">
          {preview.slides.map((slide) => (
            <li key={slide.index}>
              <strong>
                {ppmT("canvas.file_slide")} {slide.index}
                {slide.title ? ` · ${slide.title}` : ""}
              </strong>
              {slide.text && <p>{slide.text}</p>}
            </li>
          ))}
        </ol>
        {truncated}
      </>
    );
  return <p className="ppm-file-preview__message">{ppmT("canvas.file_preview_unsupported")}</p>;
}

function PreviewTable({ rows }: { rows: string[][] }) {
  return (
    <div className="ppm-file-preview__table">
      <table>
        <tbody>
          {rows.map((row, rowIndex) => (
            // oxlint-disable-next-line react/no-array-index-key -- строки таблицы только для чтения: позиция и есть содержание
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) =>
                rowIndex === 0 ? (
                  // oxlint-disable-next-line react/no-array-index-key -- столбец таблицы: позиция и есть содержание
                  <th key={cellIndex}>{cell}</th>
                ) : (
                  // oxlint-disable-next-line react/no-array-index-key -- столбец таблицы: позиция и есть содержание
                  <td key={cellIndex}>{cell}</td>
                )
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PreviewCode({ language, text }: { language: string; text: string }) {
  // Плохая грамматика не ломает просмотр: запасной вид — те же строки без подсветки (как в блоке кода B2).
  const lines = useMemo<TCodeSegment[][] | null>(() => {
    if (text.length > NUMBERED_TEXT_MAX_CHARS) return null;
    try {
      return highlightCodeLines(text, language);
    } catch {
      return text.split("\n").map((line) => (line ? [{ className: "", text: line }] : []));
    }
  }, [language, text]);
  if (!lines)
    return (
      <pre className="ppm-file-preview__code">
        <code>{text}</code>
      </pre>
    );
  return (
    <pre className="ppm-file-preview__code">
      <code>
        {lines.map((line, lineIndex) => (
          // oxlint-disable-next-line react/no-array-index-key -- строки кода заново выводятся из текста, порядок и есть содержание
          <span className="ppm-file-preview__line" key={lineIndex}>
            <span aria-hidden="true" className="ppm-file-preview__number">
              {lineIndex + 1}
            </span>
            {line.map((segment, segmentIndex) => (
              // oxlint-disable-next-line react/no-array-index-key -- сегменты подсветки: иной идентичности, кроме позиции, нет
              <span className={segment.className || undefined} key={segmentIndex}>
                {segment.text}
              </span>
            ))}
            {"\n"}
          </span>
        ))}
      </code>
    </pre>
  );
}
