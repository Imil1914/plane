/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import {
  createContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { File as FileGlyph, FileImage, FileText, LoaderCircle, Search, Upload, X } from "lucide-react";
import type { TPpmTranslationKey } from "@ppm/brand";
import { parseSerializedPpmCanvasNode } from "@ppm/canvas";
import { useTranslation } from "@plane/i18n";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import type { TPpmVaultEntry } from "@/services/ppm-vault.service";
import { PPM_VAULT_ACCEPT } from "./canvas-file-kind";
import { fillCanvasTemplate } from "./canvas-grammar";
import { formatPageUpdated } from "./canvas-pages";
import type { TPpmCanvasCommand } from "./commands";
import type { TPpmCanvasShape } from "./shape";

// AF2.1, финальная волна (I-1): пункты рейки «Из проекта» — не пустые case. «Файл» — выбор файла Хранилища (по образцу
// «Документа PPM», canvas-page-picker.tsx) или загрузка с компьютера тем же путём, что ⌘U; «Git-объект» — страница кода
// проекта (её «На холст» возвращает на Холст с объектом, см. ppm_git_* в editor.tsx). Чистая логика — здесь же, без DOM:
// её проверяет files-vault-picker.test.ts; действия с редактором и сервисами — блок «(final)» в editor.tsx.

// ─────────────── «Из проекта» (рейка K1): пункты линии B — один диспетчер ───────────────
// «Задача» и «Доска задач» — прежние case волны 1 в CanvasControls (их держит и гард F2 в af21-foundation.test.ts);
// «Документ PPM», «Файл» и «Git-объект» идут сюда, и у каждого — настоящее действие, а не пустой break.

export const PPM_PROJECT_SOURCE_COMMANDS = [
  "add-page-ref",
  "add-file",
  "add-git",
] as const satisfies readonly TPpmCanvasCommand[];

export type TPpmProjectSourceCommand = (typeof PPM_PROJECT_SOURCE_COMMANDS)[number];

export type TPpmProjectSourceDeps = {
  /** «Документ PPM»: поиск существующих документов (B3). */
  openPagePicker: () => void;
  /** «Git-объект»: страница кода проекта. */
  openProjectCode: () => void;
  /** «Файл»: файл Хранилища или с компьютера. */
  openVaultPicker: () => void;
};

const PROJECT_SOURCE_ACTIONS: Readonly<Record<TPpmProjectSourceCommand, keyof TPpmProjectSourceDeps>> = {
  "add-file": "openVaultPicker",
  "add-git": "openProjectCode",
  "add-page-ref": "openPagePicker",
};

export function isProjectSourceCommand(command: string): command is TPpmProjectSourceCommand {
  return (PPM_PROJECT_SOURCE_COMMANDS as readonly string[]).includes(command);
}

/** Пункт «Из проекта» для редактора; читателю — ничего (рейка ему эти пункты и не показывает). */
export function runProjectSourceCommand(
  command: TPpmProjectSourceCommand,
  canEdit: boolean,
  deps: TPpmProjectSourceDeps
): void {
  if (!canEdit) return;
  deps[PROJECT_SOURCE_ACTIONS[command]]();
}

/** Что CanvasControls (оверлей tldraw) берёт у PpmCanvasEditor: состояние выбора и переход живут в редакторе доски. */
export type TPpmCanvasProjectSources = Pick<TPpmProjectSourceDeps, "openProjectCode" | "openVaultPicker">;

export const PpmCanvasProjectSourcesContext = createContext<TPpmCanvasProjectSources>({
  openProjectCode: () => undefined,
  openVaultPicker: () => undefined,
});

// ─────────────── «Git-объект»: страница кода проекта ───────────────

export function projectCodePath(workspaceSlug: string, projectId: string): string {
  return `/${workspaceSlug}/projects/${projectId}/code`;
}

export type TCanvasSaveSettleDeps = {
  /** Тот же flushSave, что у автосохранения (при размонтировании редактор зовёт его же). */
  flush: () => Promise<void>;
  hasUnsaved: () => boolean;
  intervalMs?: number;
  isSaving: () => boolean;
  /** Один раз, если ждать всё-таки придётся (показать «Сохраняем доску…»). */
  onWait?: () => void;
  sleep: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

/**
 * Перед уходом с Холста: сохранение, которое уже идёт, дожидаемся; несохранённое — сохраняем (не больше двух попыток:
 * вторая — если за время первой успели ещё что-то изменить). true — на сервере всё; false — сохранить не удалось
 * или сохранение зависло (timeoutMs): уходить нельзя.
 */
export async function settleCanvasSave({
  flush,
  hasUnsaved,
  intervalMs = 150,
  isSaving,
  onWait,
  sleep,
  timeoutMs = 10_000,
}: TCanvasSaveSettleDeps): Promise<boolean> {
  let flushes = 0;
  let waited = 0;
  let announced = false;
  const announce = () => {
    if (announced) return;
    announced = true;
    onWait?.();
  };
  for (;;) {
    if (isSaving()) {
      if (waited >= timeoutMs) return false;
      announce();
      // oxlint-disable-next-line no-await-in-loop -- ждём сохранение, которое уже идёт, через равные промежутки
      await sleep(intervalMs);
      waited += intervalMs;
      continue;
    }
    if (!hasUnsaved()) return true;
    if (flushes >= 2) return false;
    announce();
    flushes += 1;
    // oxlint-disable-next-line no-await-in-loop -- следующая попытка нужна, только если предыдущая сохранила не всё
    await flush();
  }
}

export type TOpenProjectCodeDeps = {
  navigate: (path: string) => void;
  notify: (message: string) => void;
  projectId: string;
  settleSave: () => Promise<boolean>;
  t: (key: TPpmTranslationKey) => string;
  workspaceSlug: string;
};

/** «Из проекта → Git-объект»: страница кода проекта — только когда доска сохранена; иначе остаёмся и говорим почему. */
export async function openProjectCodePage(deps: TOpenProjectCodeDeps): Promise<boolean> {
  if (!(await deps.settleSave())) {
    deps.notify(deps.t("canvas.git_leave_unsaved"));
    return false;
  }
  deps.navigate(projectCodePath(deps.workspaceSlug, deps.projectId));
  return true;
}

// ─────────────── «Файл»: файлы Хранилища ───────────────

export const CANVAS_VAULT_PICKER_LIMIT = 50;

/** Файлы дерева Хранилища (папки — только контейнеры): активные записи, сверху вниз по дереву. */
export function vaultFilesOf(entries: readonly TPpmVaultEntry[]): TPpmVaultEntry[] {
  const files: TPpmVaultEntry[] = [];
  // Стек вместо рекурсии (глубина дерева приходит с сервера); детей кладём с конца, чтобы снимать их по порядку.
  const stack: TPpmVaultEntry[] = [];
  const pushInOrder = (list: readonly TPpmVaultEntry[]) => {
    for (let index = list.length - 1; index >= 0; index -= 1) stack.push(list[index]);
  };
  pushInOrder(entries);
  for (let entry = stack.pop(); entry; entry = stack.pop()) {
    if (entry.status !== "active") continue;
    if (entry.kind === "folder") pushInOrder(entry.children ?? []);
    else files.push(entry);
  }
  return files;
}

/** «Отчёты / 2026» — папка файла; у файла в корне Хранилища — пусто. */
export function vaultFileFolder(entry: Pick<TPpmVaultEntry, "path">): string {
  return entry.path.split("/").slice(0, -1).filter(Boolean).join(" / ");
}

const searchable = (text: string) => text.toLocaleLowerCase("ru").replaceAll("ё", "е");

const updatedAt = (entry: TPpmVaultEntry) => {
  const time = Date.parse(entry.updated_at);
  return Number.isNaN(time) ? 0 : time;
};

/** Поиск по имени на клиенте (регистр и «ё» не важны), свежие сверху, не больше `limit`; total — все совпадения. */
export function searchVaultFiles(
  files: readonly TPpmVaultEntry[],
  query: string,
  limit = CANVAS_VAULT_PICKER_LIMIT
): { hits: TPpmVaultEntry[]; total: number } {
  const needle = searchable(query.trim());
  const matches = files
    .filter((file) => !needle || searchable(file.name).includes(needle))
    // oxlint-disable-next-line unicorn/no-array-sort -- filter returns a fresh array (lib ES2022: no toSorted).
    .sort((left, right) => updatedAt(right) - updatedAt(left) || left.name.localeCompare(right.name, "ru"));
  return { hits: matches.slice(0, limit), total: matches.length };
}

// shape.tsx's PPM_CANVAS_SHAPE_TYPE как проверенный литерал: импорт shape.tsx потянул бы все карточки (и их импорты).
const PPM_CANVAS_SHAPE_TYPE = "ppm-canvas-node" satisfies TPpmCanvasShape["type"];

/** Карточка, уже привязанная к этому источнику (файл Хранилища, вложение задачи), — чтобы повтор не плодил дубли. */
export function boundCardId(
  shapes: readonly { id: string; props: unknown; type: string }[],
  entityType: "attachment" | "vault_file",
  entityId: string
): string | undefined {
  for (const shape of shapes) {
    if (shape.type !== PPM_CANVAS_SHAPE_TYPE) continue;
    const serialized = (shape.props as { node?: unknown } | null)?.node;
    if (typeof serialized !== "string") continue;
    const parsed = parseSerializedPpmCanvasNode(serialized);
    if (parsed.status !== "valid" && parsed.status !== "migrated") continue;
    const { node } = parsed;
    // Файлы и вложения живут в карточках pdf/image/reference (createPpmContentRefNode), старые — в *_ref.
    if (
      node.kind !== "pdf" &&
      node.kind !== "image" &&
      node.kind !== "reference" &&
      node.kind !== "attachment_ref" &&
      node.kind !== "vault_file_ref"
    )
      continue;
    if (node.binding?.entity_type === entityType && node.binding.entity_id === entityId) return shape.id;
  }
  return undefined;
}

/**
 * Раунд 2 (m-3): выбор файла. Карточка на холсте — выбор закрывается. Отказ — сообщение в самом выборе: уведомление
 * холста лежит под подложкой диалога и не видно. Выбор остаётся открытым: можно повторить или взять другой файл.
 */
export async function pickVaultFile(
  file: TPpmVaultEntry,
  deps: {
    errorText: string;
    onClose: () => void;
    onPick: (file: TPpmVaultEntry) => Promise<void>;
    setError: (message: string | undefined) => void;
  }
): Promise<boolean> {
  deps.setError(undefined);
  try {
    await deps.onPick(file);
  } catch {
    deps.setError(deps.errorText);
    return false;
  }
  deps.onClose();
  return true;
}

// Скрытый выбор файлов не участвует в ловушке Tab: он не фокусируется, его открывает кнопка «Загрузить с компьютера…».
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]):not([type="file"]), [tabindex]:not([tabindex="-1"])';

function VaultFileIcon({ kind }: { kind: TPpmVaultEntry["kind"] }) {
  if (kind === "image") return <FileImage aria-hidden="true" />;
  if (kind === "markdown" || kind === "pdf") return <FileText aria-hidden="true" />;
  return <FileGlyph aria-hidden="true" />;
}

/**
 * «Файл из Хранилища». Порталом в body (внутри редактора остаётся ровно один [role="dialog"] — предпросмотр импорта,
 * e2e-якорь). Клавиши не уходят на холст: Escape (e.code) закрывает, Tab ходит по кругу, стрелки двигают подсветку,
 * Enter выбирает только из поля поиска. Горячие клавиши tldraw выключает общий эффект фокуса (canvasModalOpen,
 * editor.tsx). Отказ размещения назван в самом выборе (раунд 2, m-3) — диалог остаётся открытым для повтора.
 */
export function PpmCanvasVaultPicker({
  loadFiles,
  onClose,
  onPick,
  onUpload,
}: {
  loadFiles: () => Promise<TPpmVaultEntry[]>;
  onClose: () => void;
  onPick: (file: TPpmVaultEntry) => Promise<void>;
  onUpload: (files: File[]) => void;
}) {
  const ppmT = usePpmTranslation();
  const { currentLocale } = useTranslation();
  const listboxId = useId();
  // undefined — список ещё грузится.
  const [files, setFiles] = useState<TPpmVaultEntry[]>();
  // Ошибка — не то же самое, что «файлов нет»: своё сообщение и «Повторить».
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [placing, setPlacing] = useState<string>();
  // Раунд 2 (m-3): отказ размещения — здесь, в области сообщения выбора (уведомление холста под подложкой не видно).
  const [pickError, setPickError] = useState<string>();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Один запрос на открытие (и на «Повторить»): поиск по имени — на клиенте, без запроса на каждую букву.
  useEffect(() => {
    let active = true;
    setFiles(undefined);
    setLoadError(false);
    void loadFiles().then(
      (loaded) => {
        if (active) setFiles(loaded);
        return undefined;
      },
      () => {
        if (active) setLoadError(true);
      }
    );
    return () => {
      active = false;
    };
  }, [attempt, loadFiles]);

  // Фокус — сразу в поиск: диалог открыт командой рейки или палитры, а не щелчком по полю.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const result = useMemo(() => (files ? searchVaultFiles(files, query) : undefined), [files, query]);
  const hits = useMemo(() => result?.hits ?? [], [result]);
  const active = hits.length > 0 ? Math.min(activeIndex, hits.length - 1) : -1;
  const loading = !files && !loadError;
  const optionId = (file: TPpmVaultEntry) => `${listboxId}-option-${file.id}`;

  // Подсветка, уведённая стрелками за край списка, остаётся видимой.
  useEffect(() => {
    if (active < 0) return;
    dialogRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = async (file: TPpmVaultEntry) => {
    // Замок: двойной щелчок или Enter во время размещения второй карточки не кладёт.
    if (placing) return;
    setPlacing(file.id);
    try {
      await pickVaultFile(file, {
        errorText: fillCanvasTemplate(ppmT("canvas.vault_pick_place_error"), { name: file.name }),
        onClose,
        onPick,
        setError: setPickError,
      });
    } finally {
      setPlacing(undefined);
    }
  };

  const onFilesChosen = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = "";
    if (chosen.length === 0) return;
    onUpload(chosen);
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Портал в body, но React-всплытие идёт по дереву редактора: клавиши диалога не доходят ни до холста, ни до tldraw.
    event.stopPropagation();
    if (event.code === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.code === "Tab") {
      const dialog = dialogRef.current;
      const focusable = dialog ? [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)] : [];
      if (!dialog || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;
      // Фокус мог остаться на самом диалоге (tabIndex={-1}) — Tab/Shift+Tab всё равно остаются внутри.
      if (event.shiftKey && (current === first || current === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || current === dialog)) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if ((event.code === "ArrowDown" || event.code === "ArrowUp") && hits.length > 0) {
      event.preventDefault();
      setActiveIndex((active + (event.code === "ArrowDown" ? 1 : -1) + hits.length) % hits.length);
      return;
    }
    // Enter выбирает подсвеченный файл только из поля поиска: на «×» или «Загрузить…» Enter делает своё.
    if ((event.code === "Enter" || event.code === "NumpadEnter") && event.target === inputRef.current && active >= 0) {
      event.preventDefault();
      void pick(hits[active]);
    }
  };

  return createPortal(
    <div className="ppm-canvas-content-backdrop" role="presentation" onPointerDown={onClose}>
      <div
        ref={dialogRef}
        aria-label={ppmT("canvas.vault_pick_title")}
        aria-modal="true"
        className="ppm-canvas-page-picker ppm-canvas-vault-picker"
        // Маркер диалогов-порталов холста: пока он в документе, workspace.tsx свои клавиши не обрабатывает (B3, R-b).
        data-ppm-canvas-modal=""
        role="dialog"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header>
          <strong>{ppmT("canvas.vault_pick_title")}</strong>
          <button type="button" aria-label={ppmT("canvas.close")} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <label className="ppm-canvas-page-picker__search">
          <Search aria-hidden="true" />
          <input
            ref={inputRef}
            aria-activedescendant={active >= 0 ? optionId(hits[active]) : undefined}
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded={hits.length > 0}
            aria-label={ppmT("canvas.vault_search_placeholder")}
            placeholder={ppmT("canvas.vault_search_placeholder")}
            role="combobox"
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setPickError(undefined);
              setActiveIndex(0);
            }}
          />
          {loading && <LoaderCircle aria-hidden="true" className="ppm-canvas-page-picker__spinner" />}
        </label>
        <ul aria-busy={loading || undefined} aria-label={ppmT("canvas.vault_pick_title")} id={listboxId} role="listbox">
          {hits.map((file, index) => {
            const meta = [
              vaultFileFolder(file),
              formatPageUpdated(file.updated_at, currentLocale, ppmT("canvas.page_updated")),
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <li key={file.id} aria-selected={index === active} data-index={index} id={optionId(file)} role="option">
                <button
                  type="button"
                  // Не disabled: фокус остался бы в body, и Esc/Tab перестали бы доходить до диалога.
                  aria-disabled={placing ? true : undefined}
                  onClick={() => void pick(file)}
                  onFocus={() => setActiveIndex(index)}
                  onPointerEnter={() => setActiveIndex(index)}
                >
                  <VaultFileIcon kind={file.kind} />
                  <span>
                    <strong>{file.name}</strong>
                    {meta && <small>{meta}</small>}
                  </span>
                  {placing === file.id && (
                    <LoaderCircle aria-hidden="true" className="ppm-canvas-page-picker__spinner" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        {pickError && (
          <p className="ppm-canvas-page-picker__error" role="alert">
            {pickError}
          </p>
        )}
        {loadError && (
          <p className="ppm-canvas-page-picker__error">
            {ppmT("canvas.vault_load_error")}
            <button type="button" onClick={() => setAttempt((current) => current + 1)}>
              {ppmT("vault.retry")}
            </button>
          </p>
        )}
        {files && files.length === 0 && <p className="ppm-canvas-vault-picker__empty">{ppmT("canvas.vault_empty")}</p>}
        {files && files.length > 0 && hits.length === 0 && (
          <p className="ppm-canvas-vault-picker__empty">{ppmT("canvas.vault_search_empty")}</p>
        )}
        {result && result.total > result.hits.length && (
          <small>{fillCanvasTemplate(ppmT("canvas.vault_search_limited"), { count: result.hits.length })}</small>
        )}
        <footer className="ppm-canvas-vault-picker__footer">
          <button
            type="button"
            className="ppm-canvas-vault-picker__upload"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload aria-hidden="true" />
            {ppmT("canvas.vault_pick_upload")}
          </button>
          {/* Тот же путь, что ⌘U: файлы уходят в putExternalContent({ type: "files" }) → Хранилище (B4). */}
          <input
            ref={fileInputRef}
            hidden
            type="file"
            multiple
            accept={PPM_VAULT_ACCEPT.join(",")}
            onChange={onFilesChosen}
          />
        </footer>
      </div>
    </div>,
    window.document.body
  );
}
