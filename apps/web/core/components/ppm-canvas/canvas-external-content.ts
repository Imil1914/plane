/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Editor, VecLike } from "tldraw";
import type { TPpmTranslationKey } from "@ppm/brand";
import { fillCanvasTemplate } from "./canvas-grammar";
import { extensionForMime, fileExtension, isVaultUploadable } from "./canvas-file-kind";

// AF2.1 B4 (R5, вариант A): вставка ⌘V, перетаскивание и ⌘U идут через обработчики внешнего контента tldraw →
// Хранилище → живая карточка. В снимке доски не остаётся base64. Обработчики регистрируются один раз в onMount,
// актуальное состояние читается через getDeps (refs). Под v1 — стандартные обработчики tldraw (как в UX1.1).
export const PPM_PASTE_MAX_FILES = 20;
const GENERIC_FILE_NAMES = /^(?:tldrawfile|image|blob|file|untitled|pasted[ -]?image|screenshot)(?:\.[a-z0-9]+)?$/i;

export type TPpmCanvasExternalContentDeps = {
  canEdit: boolean;
  createLinkNote: (url: string, point: VecLike) => void;
  grammarV2: boolean;
  // Мультидоска: вкладка этой доски активна. Редактор скрытой вкладки (workspace.tsx держит смонтированными все открытые)
  // не делает ничего — ни загрузки, ни карточки, ни делегирования обработчикам tldraw, ни уведомления. Второй уровень
  // защиты: вставку и так слушает только редактор «в фокусе» (syncCanvasEditorFocus в editor.tsx).
  isActive: boolean;
  // Раунд 1: min(PPM_VAULT_MAX_UPLOAD_BYTES, фактический лимит инстанса) — см. editor.tsx, useFileSize().
  maxUploadBytes: number;
  notify: (message: string) => void;
  now: () => Date;
  placeVaultEntry: (entryId: string, point: VecLike, index: number) => Promise<void>;
  t: (key: TPpmTranslationKey) => string;
  uploadToVault: (file: File) => Promise<{ id: string }>;
};

const pad = (value: number) => String(value).padStart(2, "0");

/** «image.png» из буфера и «tldrawFile» → «Вставка-2026-09-25-153012.png»; настоящие имена сохраняются. */
export function pastedFileName(file: { name: string; type: string }, now: Date): string {
  const ownExtension = fileExtension(file.name);
  if (file.name && ownExtension && !GENERIC_FILE_NAMES.test(file.name)) return file.name;
  const extension = ownExtension || extensionForMime(file.type);
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(
    now.getMinutes()
  )}${pad(now.getSeconds())}`;
  return `Вставка-${stamp}${extension ? `.${extension}` : ""}`;
}

export function withNameSuffix(name: string, attempt: number): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${attempt})${name.slice(dot)}` : `${name} (${attempt})`;
}

export function isVaultNameConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "VAULT_NAME_CONFLICT";
}

/** 409 VAULT_NAME_CONFLICT несёт details.suggested_name (services.py: _suggest_free_name) — сервер уже проверил его. */
function vaultSuggestedName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const details = (error as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return undefined;
  const suggested = (details as { suggested_name?: unknown }).suggested_name;
  return typeof suggested === "string" && suggested.length > 0 ? suggested : undefined;
}

/** Имя занято (409 VAULT_NAME_CONFLICT) → имя сервера (details.suggested_name), иначе «Имя (2).ext»… до 5 попыток. */
export async function uploadWithUniqueName<T>(
  upload: (file: File) => Promise<T>,
  file: File,
  name: string,
  attempts = 5
): Promise<T> {
  let candidate = name;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // Повторы обязаны быть последовательными: следующая попытка нужна, только если предыдущая получила 409
      // VAULT_NAME_CONFLICT, и использует его (или подсказку сервера) для выбора следующего имени.
      // oxlint-disable-next-line no-await-in-loop -- намеренно последовательно, см. комментарий выше
      return await upload(new File([file], candidate, { lastModified: file.lastModified, type: file.type }));
    } catch (error) {
      lastError = error;
      if (!isVaultNameConflict(error)) throw error;
      candidate = vaultSuggestedName(error) ?? withNameSuffix(name, attempt + 1);
    }
  }
  throw lastError;
}

export function dropHintKey(
  count: number,
  locale: string
): "canvas.drop_hint_few" | "canvas.drop_hint_many" | "canvas.drop_hint_one" {
  const category = new Intl.PluralRules(locale.toLowerCase().startsWith("ru") ? "ru" : "en").select(count);
  if (category === "one") return "canvas.drop_hint_one";
  if (category === "few") return "canvas.drop_hint_few";
  return "canvas.drop_hint_many";
}

function uploadLimitMb(maxUploadBytes: number): number {
  return Math.max(1, Math.round(maxUploadBytes / (1024 * 1024)));
}

export async function putFilesIntoVault(
  deps: TPpmCanvasExternalContentDeps,
  files: readonly File[],
  point: VecLike
): Promise<number> {
  if (!deps.canEdit) {
    deps.notify(deps.t("canvas.file_drop_placeholder"));
    return 0;
  }
  const now = deps.now();
  const skipped = Math.max(0, files.length - PPM_PASTE_MAX_FILES);
  const named = files.slice(0, PPM_PASTE_MAX_FILES).map((file) => ({ file, name: pastedFileName(file, now) }));
  const rejected = named.filter(({ name }) => !isVaultUploadable(name)).map(({ name }) => name);
  const uploadable = named.filter(({ name }) => isVaultUploadable(name));
  const maxMb = uploadLimitMb(deps.maxUploadBytes);
  const oversized = uploadable
    .filter(({ file }) => file.size > deps.maxUploadBytes)
    .map(({ name }) => fillCanvasTemplate(deps.t("canvas.paste_too_large"), { max: maxMb, name }));
  // Раунд 1: файл больше лимита не загружаем вовсе («send nothing») — отказ показываем сразу, без запроса к серверу.
  const withinSize = uploadable.filter(({ file }) => file.size <= deps.maxUploadBytes);
  const errors: { message: string; name: string }[] = [];
  let placed = 0;
  let savedNotPlaced = 0;
  for (const [index, { file, name }] of withinSize.entries()) {
    let entry: { id: string };
    try {
      // Последовательно: у файлов одной вставки автоимя может совпасть (та же секунда) — параллельные загрузки
      // гонялись бы за одним именем при проверке конфликта на сервере, а индекс размещения должен идти по порядку.
      // oxlint-disable-next-line no-await-in-loop -- намеренно последовательно, см. комментарий выше
      entry = await uploadWithUniqueName(deps.uploadToVault, file, name);
    } catch (error) {
      errors.push({
        message: error instanceof Error && error.message ? error.message : deps.t("canvas.paste_upload_error"),
        name,
      });
      continue;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- часть той же последовательной обработки файла
      await deps.placeVaultEntry(entry.id, point, index);
      placed += 1;
    } catch {
      // Раунд 1: файл уже в Хранилище — это не ошибка загрузки. Отдельный счётчик, чтобы никто не бросал файл
      // повторно и не плодил «Имя (2)»: он уже сохранён, его нужно только добавить с холста («Из проекта → Файл»).
      savedNotPlaced += 1;
    }
  }
  const parts = [
    placed > 0 ? fillCanvasTemplate(deps.t("canvas.paste_saved"), { count: placed }) : null,
    savedNotPlaced > 0 ? fillCanvasTemplate(deps.t("canvas.paste_not_placed"), { count: savedNotPlaced }) : null,
    rejected.length > 0 ? fillCanvasTemplate(deps.t("canvas.paste_unsupported"), { names: rejected.join(", ") }) : null,
    skipped > 0
      ? fillCanvasTemplate(deps.t("canvas.paste_skipped"), { count: skipped, max: PPM_PASTE_MAX_FILES })
      : null,
    ...oversized,
    ...errors.map(({ message, name }) => `«${name}»: ${message}`),
  ].filter((part): part is string => Boolean(part));
  if (parts.length > 0) deps.notify(parts.join(" "));
  return placed;
}

// ── Финальная волна (M-3): файлы, брошенные на живую карточку задачи (v2, RB10) — вложения этой задачи ──
// Шаблон B4 (putFilesIntoVault выше): размер — до загрузки (лимит вложений инстанса, useFileSize()), ошибки — с именами
// файлов и без сырого error.message, счётчики «прикреплено / не удалось». Память сеанса редактора: файл (задача + имя +
// размер + время изменения), уже прикреплённый в этом сеансе, второй раз не загружается — повтор только кладёт
// недостающую карточку.

/** Запись памяти: assetId — вложение уже есть; без assetId — загрузка ещё идёт (второй бросок того же файла ждёт её). */
export type TPpmWorkItemAttachMemory = Map<string, { assetId?: string }>;

export type TPpmWorkItemAttachDeps = {
  /** Карточка этого вложения уже на холсте. */
  isPlaced: (assetId: string) => boolean;
  maxUploadBytes: number;
  memory: TPpmWorkItemAttachMemory;
  notify: (message: string) => void;
  place: (assetId: string, index: number) => Promise<void>;
  t: (key: TPpmTranslationKey) => string;
  upload: (file: File) => Promise<{ asset_id: string }>;
  workItemId: string;
  workItemName: string;
};

export type TPpmWorkItemAttachOutcome = {
  already: number;
  attached: number;
  failed: string[];
  notPlaced: number;
  tooLarge: string[];
};

export function attachmentFingerprint(workItemId: string, file: Pick<File, "lastModified" | "name" | "size">): string {
  return JSON.stringify([workItemId, file.name, file.size, file.lastModified]);
}

export function describeWorkItemAttach(
  outcome: TPpmWorkItemAttachOutcome,
  deps: Pick<TPpmWorkItemAttachDeps, "maxUploadBytes" | "t" | "workItemName">
): string {
  const { t } = deps;
  const name = deps.workItemName;
  const quoted = (fileName: string) => fillCanvasTemplate(t("canvas.checklist_item_quoted"), { name: fileName });
  const maxMb = uploadLimitMb(deps.maxUploadBytes);
  return [
    outcome.attached > 0 ? fillCanvasTemplate(t("canvas.drop_attached"), { count: outcome.attached, name }) : null,
    outcome.already > 0 ? fillCanvasTemplate(t("canvas.drop_attach_already"), { count: outcome.already, name }) : null,
    outcome.notPlaced > 0
      ? fillCanvasTemplate(t("canvas.drop_attach_not_placed"), { count: outcome.notPlaced, name })
      : null,
    outcome.failed.length > 0
      ? fillCanvasTemplate(t("canvas.drop_attach_failed"), {
          count: outcome.failed.length,
          names: outcome.failed.map(quoted).join(", "),
        })
      : null,
    ...outcome.tooLarge.map((fileName) =>
      fillCanvasTemplate(t("canvas.drop_attach_too_large"), { max: maxMb, name: fileName })
    ),
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

export async function attachFilesToWorkItem(
  deps: TPpmWorkItemAttachDeps,
  files: readonly File[]
): Promise<TPpmWorkItemAttachOutcome> {
  const outcome: TPpmWorkItemAttachOutcome = { already: 0, attached: 0, failed: [], notPlaced: 0, tooLarge: [] };
  let slot = 0;
  for (const file of files) {
    const key = attachmentFingerprint(deps.workItemId, file);
    const known = deps.memory.get(key);
    // Уже прикреплён и его карточка на холсте — или его первая загрузка ещё идёт: второй раз не грузим.
    if (known && (!known.assetId || deps.isPlaced(known.assetId))) {
      outcome.already += 1;
      continue;
    }
    let assetId = known?.assetId;
    if (!assetId) {
      if (file.size > deps.maxUploadBytes) {
        outcome.tooLarge.push(file.name);
        continue;
      }
      deps.memory.set(key, {});
      try {
        // Последовательно: единый порядок карточек (slot → отступ) и общий подсчёт для уведомления.
        // oxlint-disable-next-line no-await-in-loop -- намеренно последовательно, см. комментарий выше
        assetId = (await deps.upload(file)).asset_id;
      } catch {
        deps.memory.delete(key);
        outcome.failed.push(file.name);
        continue;
      }
      deps.memory.set(key, { assetId });
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- часть той же последовательной обработки файла
      await deps.place(assetId, slot);
      slot += 1;
      outcome.attached += 1;
    } catch {
      // Вложение у задачи уже есть: это не ошибка загрузки. Повторный бросок только положит карточку.
      outcome.notPlaced += 1;
    }
  }
  const message = describeWorkItemAttach(outcome, deps);
  if (message) deps.notify(message);
  return outcome;
}

// tldraw's shipped public .d.ts excludes the `externalContentHandlers` field from `Editor`'s type (API-Extractor
// `@internal` rollup — confirmed against the resolved @tldraw/editor 3.15.6: its index.d.ts has a bare
// `/* Excluded from this release type: externalContentHandlers */` marker and no other declaration of the field),
// even though the class still carries it at runtime and `registerExternalContentHandler`/`putExternalContent`
// stay public. Reading the handler tldraw registered by default (to delegate to it under v1, and to restore it on
// dispose) needs that field, so its shape is asserted once here instead of on every access.
type TTldrawExternalContentHandlerMap = Record<string, ((info: unknown) => unknown) | null | undefined>;
function tldrawExternalContentHandlers(editor: Editor): TTldrawExternalContentHandlerMap {
  // Раунд 1: `?? {}` — если tldraw когда-нибудь переименует/уберёт поле, это не должно ронять onMount (ни v1, ни v2);
  // худший случай — обработчики v1 не находят previous.* и молча не делегируют (для v2 разница не видна вовсе).
  return (
    (editor as unknown as { externalContentHandlers?: TTldrawExternalContentHandlerMap }).externalContentHandlers ?? {}
  );
}

/** Раунд 1: перетаскивание/вставка «сети» (адресной строки, ссылки) — только http(s), остальное молча игнорируем. */
function isHttpUrl(url: string): boolean {
  try {
    const scheme = new URL(url).protocol;
    return scheme === "http:" || scheme === "https:";
  } catch {
    return false;
  }
}

export function registerPpmCanvasExternalContent(
  editor: Editor,
  getDeps: () => TPpmCanvasExternalContentDeps
): () => void {
  const handlers = tldrawExternalContentHandlers(editor);
  const previous = {
    files: handlers.files,
    svg: handlers["svg-text"],
    url: handlers.url,
  };
  // Мультидоска: скрытая вкладка — первой проверкой, раньше выбора v1/v2 (под v1 тоже никакого делегирования).
  editor.registerExternalContentHandler("files", async (info) => {
    const deps = getDeps();
    if (!deps.isActive) return;
    if (!deps.grammarV2) return previous.files?.(info);
    await putFilesIntoVault(deps, info.files, info.point ?? editor.getViewportPageBounds().center);
  });
  editor.registerExternalContentHandler("url", async (info) => {
    const deps = getDeps();
    if (!deps.isActive) return;
    if (!deps.grammarV2) return previous.url?.(info);
    // Раунд 1: читатель видит то же объяснение, что и при файлах, и ничего не создаётся — как для files/svg-text.
    if (!deps.canEdit) {
      deps.notify(deps.t("canvas.file_drop_placeholder"));
      return;
    }
    // Раунд 1: только http(s) — javascript:/data:/file: и прочее молча игнорируем, без уведомления и без сети.
    if (!isHttpUrl(info.url)) return;
    // RB11: без запроса в сеть (стандартный обработчик тянет страницу ради превью закладки).
    deps.createLinkNote(info.url, info.point ?? editor.getViewportPageBounds().center);
  });
  editor.registerExternalContentHandler("svg-text", async (info) => {
    const deps = getDeps();
    if (!deps.isActive) return;
    if (!deps.grammarV2) return previous.svg?.(info);
    // Раунд 1: то же «только для редакторов», что и для files/url — читателю не показываем повод «SVG не поддерживается».
    deps.notify(deps.t(deps.canEdit ? "canvas.paste_svg_unsupported" : "canvas.file_drop_placeholder"));
  });
  return () => {
    editor.registerExternalContentHandler("files", previous.files ?? null);
    editor.registerExternalContentHandler("url", previous.url ?? null);
    editor.registerExternalContentHandler("svg-text", previous.svg ?? null);
  };
}
