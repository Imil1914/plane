/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// ── B5: просмотр файлов ──
import { languageForFileName } from "./canvas-code";

// AF2.1 B4/B5: форматы Хранилища и виды просмотра. Список расширений — зеркало сервера
// (apps/api/plane/ppm_vault/services.py: IMAGE_SIGNATURES + REFERENCE_MIME_TYPES; apps/api/plane/ppm_vault/
// formats.py: CODE_TEXT_EXTENSIONS); сервер остаётся источником истины.
export const PPM_VAULT_UPLOAD_EXTENSIONS = [
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "csv",
  "doc",
  "docx",
  "json",
  "key",
  "md",
  "odp",
  "ods",
  "odt",
  "ppt",
  "pptx",
  "txt",
  "xls",
  "xlsx",
  // Копия CODE_TEXT_EXTENSIONS (apps/api/plane/ppm_vault/formats.py) — порядок как там, сервер остаётся источником истины.
  "bash",
  "c",
  "cc",
  "cfg",
  "cjs",
  "cpp",
  "cs",
  "css",
  "cxx",
  "dart",
  "go",
  "gql",
  "graphql",
  "h",
  "hpp",
  "ini",
  "java",
  "jl",
  "js",
  "jsx",
  "kt",
  "kts",
  "less",
  "log",
  "lua",
  "mjs",
  "php",
  "proto",
  "ps1",
  "py",
  "r",
  "rb",
  "rs",
  "scala",
  "scss",
  "sh",
  "sql",
  "swift",
  "tex",
  "toml",
  "ts",
  "tsv",
  "tsx",
  "yaml",
  "yml",
  "zsh",
] as const;

// Зеркало серверного лимита по умолчанию (apps/api/plane/settings/common.py: FILE_SIZE_LIMIT = 5 МБ — тот же дефолт
// у PPM_VAULT_PDF_MAX_BYTES/PPM_VAULT_IMAGE_MAX_BYTES/PPM_VAULT_FILE_MAX_BYTES). Клиент отклоняет слишком большой
// файл до отправки только чтобы не грузить заведомо отклонённый; сервер остаётся источником истины и может быть
// настроен иначе — фактический лимит инстанса уточняет `maxUploadBytes` в deps (см. editor.tsx, useFileSize()).
export const PPM_VAULT_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "application/json": "json",
  "application/msword": "doc",
  "application/pdf": "pdf",
  "application/vnd.ms-excel": "xls",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "text/csv": "csv",
  "text/markdown": "md",
  "text/plain": "txt",
};

/** Для выбора файла по ⌘U: MIME и расширения (часть ОС не знает MIME у .md/.csv/.key). */
export const PPM_VAULT_ACCEPT: readonly string[] = [
  ...Object.entries(MIME_EXTENSIONS)
    .filter(([, extension]) => (PPM_VAULT_UPLOAD_EXTENSIONS as readonly string[]).includes(extension))
    .map(([mime]) => mime),
  ...PPM_VAULT_UPLOAD_EXTENSIONS.map((extension) => `.${extension}`),
];

export function fileExtension(name: string): string {
  return /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase() ?? "";
}

export function extensionForMime(mime: string): string {
  return MIME_EXTENSIONS[mime.toLowerCase()] ?? "";
}

export function isVaultUploadable(name: string): boolean {
  return (PPM_VAULT_UPLOAD_EXTENSIONS as readonly string[]).includes(fileExtension(name));
}

// ── B5: просмотр файлов ──
export type TFilePreviewKind = "code" | "csv" | "download" | "image" | "json" | "markdown" | "office" | "pdf" | "text";

/** Предел текста для просмотра — 1 МиБ в байтах UTF-8 (capPreviewText): больше — обрезаем с пометкой. */
export const PPM_TEXT_PREVIEW_MAX_BYTES = 1_048_576;
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const OFFICE_EXTENSIONS = new Set(["docx", "xlsx", "pptx"]);

export function filePreviewKind(extension: string | null | undefined, mime: string): TFilePreviewKind {
  const type = mime.toLowerCase().split(";")[0].trim();
  const normalized = (extension ?? "").replace(/^\./, "").toLowerCase() || extensionForMime(type);
  if (IMAGE_EXTENSIONS.has(normalized) && type.startsWith("image/")) return "image";
  if (normalized === "pdf" || type === "application/pdf") return "pdf";
  if (normalized === "md" || type === "text/markdown") return "markdown";
  // TSV — та же таблица: parseCsvPreview сам находит разделитель Tab.
  if (normalized === "csv" || normalized === "tsv" || type === "text/csv" || type === "text/tab-separated-values")
    return "csv";
  if (normalized === "json" || type === "application/json") return "json";
  if (OFFICE_EXTENSIONS.has(normalized)) return "office";
  // Код Хранилище хранит как text/plain: язык подсветки — по расширению (normalizeCodeLanguage), иначе простой текст.
  if (normalized && languageForFileName(`file.${normalized}`) !== "plaintext") return "code";
  if (normalized === "txt" || normalized === "log" || type.startsWith("text/")) return "text";
  return "download";
}

/** CSV/TSV для просмотра: кавычки, «""», разделитель «,», «;» или Tab по первой строке; ≤ maxRows × maxColumns. */
export function parseCsvPreview(
  text: string,
  maxRows = 200,
  maxColumns = 50
): { rows: string[][]; truncated: boolean } {
  const newline = text.indexOf("\n");
  const firstLine = newline >= 0 ? text.slice(0, newline) : text;
  const delimiter = [";", "\t"].reduce(
    (best, candidate) => (firstLine.split(candidate).length > firstLine.split(best).length ? candidate : best),
    ","
  );
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let truncated = false;
  const pushRow = () => {
    if (row.length > maxColumns) truncated = true;
    rows.push(row.slice(0, maxColumns));
    row = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else cell += character;
      continue;
    }
    if (character === '"' && cell === "") {
      quoted = true;
      continue;
    }
    if (character === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }
    if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      cell = "";
      pushRow();
      if (rows.length >= maxRows) {
        truncated = truncated || index < text.length - 1;
        return { rows, truncated };
      }
      continue;
    }
    cell += character;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    pushRow();
  }
  return { rows, truncated };
}

/** preview_url Хранилища (…/entries/<id>/file/) → …/entries/<id>/pdf/ (RB7). */
export function vaultPdfUrlFromPreview(previewUrl: string): string {
  return previewUrl.replace(/\/file\/(?=$|[?#])/, "/pdf/");
}

/** Причина `unsupported` из превью сервера (S): лимиты и пароль — своими словами, остальное — «нет просмотра». */
export function filePreviewUnsupportedKey(
  reason: string | undefined
): "canvas.file_preview_encrypted" | "canvas.file_preview_too_large" | "canvas.file_preview_unsupported" {
  if (reason === "limits" || reason === "too_large") return "canvas.file_preview_too_large";
  if (reason === "encrypted") return "canvas.file_preview_encrypted";
  return "canvas.file_preview_unsupported";
}

/** 503 VAULT_STORAGE_FAILED (хранилище недоступно или сервер занят построением превью) и обрыв сети — «Повторить». */
export function isRetryablePreviewError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status !== "number" || status === 503;
}

/** Ошибка без ответа сервера: сеть или CORS подписанной ссылки S3 (RB9 — тогда файл скачивает сам браузер). */
export function isVaultNetworkError(error: unknown): boolean {
  return typeof (error as { status?: unknown } | null | undefined)?.status !== "number";
}

/**
 * «Нет доступа или файл удалён»: 403 (нет доступа к Хранилищу проекта) и 404 VAULT_ENTRY_NOT_FOUND (файл удалён или
 * в карантине). 404 без кода — нет самого маршрута (старый сервер, RB8): это не «удалён».
 */
export function isVaultGoneError(error: unknown): boolean {
  const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown };
  return status === 403 || (status === 404 && code === "VAULT_ENTRY_NOT_FOUND");
}

/** Текст не длиннее maxBytes байт UTF-8; режет по границе символа (не посреди многобайтовой буквы). */
export function capPreviewText(
  text: string,
  maxBytes = PPM_TEXT_PREVIEW_MAX_BYTES
): { text: string; truncated: boolean } {
  // Символ UTF-16 занимает в UTF-8 не больше 3 байт: короткий текст не кодируем вовсе.
  if (text.length * 3 <= maxBytes) return { text, truncated: false };
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  // bytes[end] — первый отброшенный байт; если он продолжение (10xxxxxx), символ разрезан — отступаем к его началу.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}
