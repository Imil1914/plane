/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TLAssetId, TLBinding, TLBindingCreate, TLPageId, TLParentId, TLShape, TLShapeId, VecLike } from "tldraw";
import type { TPpmTranslationKey } from "@ppm/brand";
import { pastedFileName, uploadWithUniqueName, withNameSuffix } from "./canvas-external-content";
import { PPM_VAULT_MAX_UPLOAD_BYTES, fileExtension } from "./canvas-file-kind";
import { fillCanvasTemplate } from "./canvas-grammar";

// canvas-image-migration.ts — AF2.1 B6 (RB13): картинки, вставленные до AF2.1, лежат в снимке доски как data: URL
// (inlineBase64AssetStore tldraw) и раздувают его. Находим их и переносим в Хранилище только по подтверждению
// редактора: сначала все загрузки и привязки (доска не меняется), потом одной точкой истории — живые карточки на
// месте картинок, удаление фигур и data:, а также ассеты data:, которые не показывает ни одна фигура (tldraw их сам
// не удаляет, и они уходят с каждым сохранением). Картинка, для которой что-то не вышло, остаётся как была.

const HISTORY_MARK = "ppm move inline images";
const NAME_STEM_MAX = 180;
const MEBIBYTE = 1024 * 1024;
// MIME файла — по сигнатуре байтов (как проверяет сервер), а не по заголовку data:.
const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  gif: "image/gif",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export type TInlineImageAsset = {
  assetId: string;
  bytes: number;
  /** Расширение по сигнатуре байтов (png, jpg, webp, gif) — по ней проверяет сервер; "" — Хранилище не примет. */
  extension: string;
  mime: string;
  name: string;
  /** Почему картинка остаётся на доске: формат не для Хранилища или больше лимита; null — переносится. */
  reason: "format" | "size" | null;
  src: string;
  supported: boolean;
};

type TAssetLike = {
  id: string;
  props?: { mimeType?: string | null; name?: string; src?: string | null };
  type: string;
};

// Те же сигнатуры, что проверяет Хранилище (apps/api/plane/ppm_vault/services.py, IMAGE_SIGNATURES).
function imageExtensionFromBytes(head: string): string {
  if (head.startsWith("\x89PNG\r\n\x1a\n")) return "png";
  if (head.startsWith("\xff\xd8\xff")) return "jpg";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "webp";
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "gif";
  return "";
}

function sniffBase64Image(payloadStart: string): string {
  try {
    return imageExtensionFromBytes(atob(payloadStart));
  } catch {
    return "";
  }
}

/** maxBytes — лимит загрузки Хранилища (по умолчанию 5 МБ, как у сервера; редактор сужает его лимитом инстанса). */
export function findInlineImageAssets(
  assets: readonly TAssetLike[],
  maxBytes = PPM_VAULT_MAX_UPLOAD_BYTES
): TInlineImageAsset[] {
  return assets.flatMap((asset) => {
    const src = asset.props?.src ?? "";
    const comma = src.indexOf(",");
    if (asset.type !== "image" || !src.startsWith("data:") || comma < 0) return [];
    const header = src.slice(5, comma);
    const base64 = header.includes(";base64");
    const mime = (header.split(";")[0] || asset.props?.mimeType || "application/octet-stream").toLowerCase();
    const payload = src.length - comma - 1;
    const padding = src.endsWith("==") ? 2 : src.endsWith("=") ? 1 : 0;
    const bytes = base64 ? Math.floor((payload * 3) / 4) - padding : payload;
    // Растровые картинки в data: бывают только base64; percent-кодированный data: — это SVG или текст.
    const extension = base64 ? sniffBase64Image(src.slice(comma + 1, comma + 17)) : "";
    const reason = !extension ? "format" : bytes > maxBytes ? "size" : null;
    return [
      {
        assetId: asset.id,
        bytes,
        extension,
        mime,
        name: asset.props?.name ?? "",
        reason,
        src,
        supported: reason === null,
      },
    ];
  });
}

/** type — MIME файла; по умолчанию из заголовка data:. */
export function dataUrlToFile(dataUrl: string, name: string, type?: string): File {
  const comma = dataUrl.indexOf(",");
  const header = dataUrl.slice(5, comma);
  const payload = dataUrl.slice(comma + 1);
  let bytes: Uint8Array;
  if (header.includes(";base64")) {
    const binary = atob(payload);
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  } else bytes = new TextEncoder().encode(decodeURIComponent(payload));
  return new File([bytes], name, { type: type ?? (header.split(";")[0] || "application/octet-stream") });
}

export function inlineImagesDismissKey(boardId: string): string {
  return `ppm-canvas-inline-images-dismissed:${boardId}`;
}

/** «Не сейчас» помнится в sessionStorage для этой доски (вкладка); недоступное хранилище — не отказ. */
export function isInlineImagesDismissed(storage: Storage | undefined, boardId: string): boolean {
  try {
    return Boolean(storage?.getItem(inlineImagesDismissKey(boardId)));
  } catch {
    return false;
  }
}

export function dismissInlineImages(storage: Storage | undefined, boardId: string): void {
  try {
    storage?.setItem(inlineImagesDismissKey(boardId), "1");
  } catch {
    // Хранилище вкладки недоступно: отказ помнит редактор доски до перезагрузки страницы.
  }
}

/** Имя файла в Хранилище: как у вставки («Вставка-…» или исходное имя), расширение — по байтам (его проверяет
 * сервер); у картинок одного переноса одно время в имени, поэтому вторая и дальше — «… (2).png». */
export function inlineImageFileName(asset: TInlineImageAsset, now: Date, ordinal: number): string {
  const base = pastedFileName({ name: asset.name, type: asset.mime }, now);
  const own = fileExtension(base);
  const stem = Array.from(
    (own ? base.slice(0, -(own.length + 1)) : base).replace(/[\\/]/g, "-").split("\0").join("").trim()
  )
    .slice(0, NAME_STEM_MAX)
    .join("");
  const extension = own === "jpeg" && asset.extension === "jpg" ? own : asset.extension;
  const name = `${stem || "Вставка"}.${extension}`;
  return base !== asset.name && ordinal > 1 ? withNameSuffix(name, ordinal) : name;
}

/** Файл для Хранилища: имя как у вставки, MIME — по сигнатуре байтов. */
export function inlineImageFile(asset: TInlineImageAsset, now: Date, ordinal: number): File {
  return dataUrlToFile(asset.src, inlineImageFileName(asset, now, ordinal), IMAGE_MIME_BY_EXTENSION[asset.extension]);
}

/** Понятная причина отказа загрузки на языке интерфейса (строки вставки B4), а не сырой текст ошибки. */
export function inlineUploadErrorMessage(
  error: unknown,
  fileName: string,
  t: (key: TPpmTranslationKey) => string,
  maxBytes: number
): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === "VAULT_FILE_TOO_LARGE")
    return fillCanvasTemplate(t("canvas.paste_too_large"), {
      max: Math.max(1, Math.round(maxBytes / MEBIBYTE)),
      name: fileName,
    });
  if (code === "VAULT_INVALID_FILE_TYPE") return fillCanvasTemplate(t("canvas.paste_unsupported"), { names: fileName });
  return t("canvas.paste_upload_error");
}

// ── Память переносов (sessionStorage вкладки, по доске) ──
// files: ассет → файл Хранилища (уже загружен — повтор его только привязывает, вторую копию не грузит);
// cards: фигура картинки → карточка, которая её заменила. После ⌘Z (картинка вернулась с тем же id, карточка осталась)
// повторный перенос только убирает картинку — без второй карточки и второго файла.
export type TInlineMoveMemory = {
  cards: Record<string, { assetId: string; cardShapeId: string }>;
  files: Record<string, string>;
};

export function inlineMovesKey(boardId: string): string {
  return `ppm-canvas-inline-images-moved:${boardId}`;
}

function isRecordOf<T>(value: unknown, check: (item: unknown) => item is T): value is Record<string, T> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every(check)
  );
}

const isCardRecord = (item: unknown): item is { assetId: string; cardShapeId: string } =>
  typeof item === "object" &&
  item !== null &&
  typeof (item as { assetId?: unknown }).assetId === "string" &&
  typeof (item as { cardShapeId?: unknown }).cardShapeId === "string";

const isString = (item: unknown): item is string => typeof item === "string";

export function readInlineMoveMemory(storage: Storage | undefined, boardId: string): TInlineMoveMemory {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(inlineMovesKey(boardId)) ?? "null");
    const { cards, files } = (parsed ?? {}) as { cards?: unknown; files?: unknown };
    return {
      cards: isRecordOf(cards, isCardRecord) ? { ...cards } : {},
      files: isRecordOf(files, isString) ? { ...files } : {},
    };
  } catch {
    return { cards: {}, files: {} };
  }
}

export function writeInlineMoveMemory(storage: Storage | undefined, boardId: string, memory: TInlineMoveMemory): void {
  try {
    storage?.setItem(inlineMovesKey(boardId), JSON.stringify(memory));
  } catch {
    // Недоступно — память живёт до перезагрузки страницы.
  }
}

export type TInlineMoveStep =
  | { cardShapeId: string; step: "reuse" }
  | { entryId: string; step: "bind" }
  | { step: "upload" };

/** Что делать с картинкой: её карточка уже на доске (после ⌘Z) — только убрать картинку; файл уже в Хранилище —
 * только привязать; иначе загрузить. */
export function inlineMoveStep(
  target: TInlineImageTarget,
  memory: TInlineMoveMemory,
  isOnBoard: (shapeId: string) => boolean
): TInlineMoveStep {
  const card = memory.cards[target.shapeId];
  if (card && card.assetId === target.asset.assetId && isOnBoard(card.cardShapeId))
    return { cardShapeId: card.cardShapeId, step: "reuse" };
  const entryId = memory.files[target.asset.assetId];
  return entryId ? { entryId, step: "bind" } : { step: "upload" };
}

export type TInlineImageUse = { assetId: string; locked: boolean; onCurrentPage: boolean; shapeId: string };

/** То, что перенос берёт у редактора tldraw (Editor подходит как есть; в тестах — заглушка). */
export type TInlineImageEditor = {
  createBindings: (partials: TLBindingCreate[]) => unknown;
  deleteBindings: (bindings: TLBinding[]) => unknown;
  deleteShape: (id: TLShapeId) => unknown;
  getBindingsToShape: (shapeId: TLShapeId, type: "arrow") => TLBinding[];
  getCurrentPageId: () => TLPageId;
  getPageShapeIds: (pageId: TLPageId) => Set<TLShapeId>;
  getPages: () => readonly { id: TLPageId }[];
  getShape: (id: TLShapeId) => TLShape | undefined;
  getShapePageBounds: (id: TLShapeId) => { center: VecLike } | undefined;
  markHistoryStoppingPoint: (name?: string) => string;
  reparentShapes: (ids: TLShapeId[], parentId: TLParentId) => unknown;
  store: { remove: (ids: TLAssetId[]) => void };
};

function imageAssetId(shape: TLShape | undefined): string | undefined {
  const assetId = shape?.type === "image" ? (shape.props as { assetId?: unknown }).assetId : undefined;
  return typeof assetId === "string" ? assetId : undefined;
}

/** Все фигуры-картинки документа (со всех страниц): какая картинка какой ассет показывает. */
export function collectInlineImageUses(editor: TInlineImageEditor): TInlineImageUse[] {
  const currentPageId = editor.getCurrentPageId();
  return editor.getPages().flatMap((page) =>
    [...editor.getPageShapeIds(page.id)].flatMap((id) => {
      const shape = editor.getShape(id);
      const assetId = imageAssetId(shape);
      return shape && assetId
        ? [{ assetId, locked: shape.isLocked, onCurrentPage: page.id === currentPageId, shapeId: shape.id }]
        : [];
    })
  );
}

export type TInlineImageTarget = { asset: TInlineImageAsset; shapeId: string };

/** Картинка всё ещё на доске, не заблокирована и показывает тот же ассет (пока шли загрузки, её могли изменить). */
export function showsInlineImage(editor: TInlineImageEditor, target: TInlineImageTarget): boolean {
  const shape = editor.getShape(target.shapeId as TLShapeId);
  return Boolean(shape && !shape.isLocked && imageAssetId(shape) === target.asset.assetId);
}

export type TInlineImagePlan = {
  locked: number;
  /** Ассеты data:, которые не показывает ни одна фигура ни на одной странице: удаляются из доски. */
  orphans: TInlineImageAsset[];
  targets: TInlineImageTarget[];
  tooLarge: number;
  unsupported: number;
};

export function planInlineImageMigration(
  assets: readonly TInlineImageAsset[],
  uses: readonly TInlineImageUse[]
): TInlineImagePlan {
  const plan: TInlineImagePlan = { locked: 0, orphans: [], targets: [], tooLarge: 0, unsupported: 0 };
  for (const asset of assets) {
    const users = uses.filter((use) => use.assetId === asset.assetId);
    if (users.length === 0) {
      plan.orphans.push(asset);
      continue;
    }
    // Картинки на другой странице tldraw не переносим и не считаем: карточка встала бы не на ту страницу.
    const shown = users.filter((use) => use.onCurrentPage);
    if (shown.length === 0) continue;
    if (asset.reason === "format") plan.unsupported += 1;
    else if (asset.reason === "size") plan.tooLarge += 1;
    else {
      // Ассет у нескольких фигур (RB13): за раз переносится первая незаблокированная, ассет остаётся у остальных.
      const free = shown.find((use) => !use.locked);
      if (free) plan.targets.push({ asset, shapeId: free.shapeId });
      else plan.locked += 1;
    }
  }
  return plan;
}

export function inlineImagesCount(plan: TInlineImagePlan): number {
  return plan.targets.length + plan.orphans.length + plan.locked + plan.tooLarge + plan.unsupported;
}

/** Можно ли что-то сделать: перенести картинки или удалить неиспользуемые. */
export function inlineImagesActionable(plan: TInlineImagePlan | undefined): boolean {
  return Boolean(plan && (plan.targets.length > 0 || plan.orphans.length > 0));
}

/** Ключ плана: тот же набор картинок — то же уведомление (без лишней перерисовки после каждого сохранения). */
export function inlineImagePlanKey(plan: TInlineImagePlan | undefined): string {
  if (!plan) return "";
  return [
    plan.targets.map((target) => `${target.asset.assetId}@${target.shapeId}`).join(","),
    plan.orphans.map((asset) => asset.assetId).join(","),
    plan.locked,
    plan.tooLarge,
    plan.unsupported,
  ].join("|");
}

/** Текст уведомления: сколько картинок и какого объёма перенесём или удалим, какие и почему останутся. */
export function describeInlineImages(
  plan: TInlineImagePlan,
  t: (key: TPpmTranslationKey) => string,
  formatSize: (bytes: number) => string,
  maxBytes = PPM_VAULT_MAX_UPLOAD_BYTES
): string {
  const size = (assets: readonly TInlineImageAsset[]) => formatSize(assets.reduce((total, a) => total + a.bytes, 0));
  return [
    plan.targets.length > 0
      ? fillCanvasTemplate(t("canvas.inline_images_notice"), {
          count: plan.targets.length,
          size: size(plan.targets.map((target) => target.asset)),
        })
      : null,
    plan.orphans.length > 0
      ? fillCanvasTemplate(t("canvas.inline_images_orphans"), { count: plan.orphans.length, size: size(plan.orphans) })
      : null,
    plan.unsupported > 0
      ? fillCanvasTemplate(t("canvas.inline_images_unsupported"), { count: plan.unsupported })
      : null,
    plan.tooLarge > 0
      ? fillCanvasTemplate(t("canvas.inline_images_too_large"), { count: plan.tooLarge, limit: formatSize(maxBytes) })
      : null,
    plan.locked > 0 ? fillCanvasTemplate(t("canvas.inline_images_locked"), { count: plan.locked }) : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

export type TInlineImageMove<TBinding> =
  | { binding: TBinding; kind: "place"; target: TInlineImageTarget }
  | { cardShapeId: string; kind: "reuse"; target: TInlineImageTarget };

type TPrepareDeps<TBinding> = {
  /** Pending-привязка файла Хранилища к новой фигуре. */
  bind: (entryId: string) => Promise<TBinding>;
  canContinue: () => boolean;
  /** Отказ загрузки → понятная строка на языке интерфейса. */
  describeError: (error: unknown, fileName: string) => string;
  file: (target: TInlineImageTarget, ordinal: number) => File;
  /** Ошибка привязки значит «файла в Хранилище больше нет»: забыть его и загрузить заново. */
  isGone: (error: unknown) => boolean;
  memory: TInlineMoveMemory;
  /** Загрузка в Хранилище; при конфликте имени (409) повторяется с подсказкой сервера или « (2)» … « (5)». */
  upload: (file: File) => Promise<{ id: string }>;
};

async function uploadTarget<TBinding>(
  editor: TInlineImageEditor,
  target: TInlineImageTarget,
  nextOrdinal: () => number,
  deps: TPrepareDeps<TBinding>
): Promise<{ entryId?: string; error?: string }> {
  let file: File;
  try {
    // Номер — только у настоящей загрузки: у имён одного переноса нет пропусков.
    file = deps.file(target, nextOrdinal());
  } catch {
    return {};
  }
  try {
    const entry = await uploadWithUniqueName(deps.upload, file, file.name);
    deps.memory.files[target.asset.assetId] = entry.id;
    // Пока грузили, картинку могли убрать: файл запомнен (повтор его привяжет), но привязку не создаём.
    return showsInlineImage(editor, target) ? { entryId: entry.id } : {};
  } catch (error) {
    return { error: deps.describeError(error, file.name) };
  }
}

async function prepareMove<TBinding>(
  editor: TInlineImageEditor,
  target: TInlineImageTarget,
  nextOrdinal: () => number,
  deps: TPrepareDeps<TBinding>
): Promise<{ error?: string; move?: TInlineImageMove<TBinding> }> {
  // Уведомление могло устареть: картинку, которая больше не показывает этот ассет, не грузим (без лишних файлов).
  if (!showsInlineImage(editor, target)) return {};
  const step = inlineMoveStep(target, deps.memory, (shapeId) => Boolean(editor.getShape(shapeId as TLShapeId)));
  if (step.step === "reuse") return { move: { cardShapeId: step.cardShapeId, kind: "reuse", target } };
  let entryId = step.step === "bind" ? step.entryId : undefined;
  if (!entryId) {
    const uploaded = await uploadTarget(editor, target, nextOrdinal, deps);
    if (!uploaded.entryId) return uploaded.error ? { error: uploaded.error } : {};
    entryId = uploaded.entryId;
  }
  try {
    return { move: { binding: await deps.bind(entryId), kind: "place", target } };
  } catch (error) {
    if (step.step !== "bind" || !deps.isGone(error)) return {};
  }
  // Запомненного файла в Хранилище больше нет (удалён): загружаем картинку заново, один раз.
  delete deps.memory.files[target.asset.assetId];
  const uploaded = await uploadTarget(editor, target, nextOrdinal, deps);
  if (!uploaded.entryId) return uploaded.error ? { error: uploaded.error } : {};
  try {
    return { move: { binding: await deps.bind(uploaded.entryId), kind: "place", target } };
  } catch {
    return {};
  }
}

/** Шаг 1: загрузки и привязки. Доска не меняется, поэтому ввод пользователя в это время не смешивается с переносом. */
export async function prepareInlineImageMoves<TBinding>(
  editor: TInlineImageEditor,
  targets: readonly TInlineImageTarget[],
  deps: TPrepareDeps<TBinding>
): Promise<{ errors: string[]; moves: TInlineImageMove<TBinding>[] }> {
  const moves: TInlineImageMove<TBinding>[] = [];
  const errors = new Set<string>();
  let ordinal = 0;
  const nextOrdinal = () => {
    ordinal += 1;
    return ordinal;
  };
  for (const target of targets) {
    if (!deps.canContinue()) break;
    // Последовательно: у картинок одного переноса одно время в имени — параллельные загрузки гонялись бы за одним
    // именем при проверке конфликта на сервере.
    // oxlint-disable-next-line no-await-in-loop -- намеренно последовательно, см. комментарий выше
    const result = await prepareMove(editor, target, nextOrdinal, deps);
    if (result.move) moves.push(result.move);
    if (result.error) errors.add(result.error);
  }
  return { errors: [...errors], moves };
}

/**
 * Финальная волна (отложенное B6): покой — «*.idle» любого инструмента (Выбор, Рука, Перо, фигуры…), а не только
 * «Выбора»: пользователь с Рукой или Пером в руке тоже не в жесте. Жест (translating, drawing…) и правка текста
 * (select.editing_shape) — не покой. Раунд 2 (m-6): режим обрезки картинки (select.crop.*, любое «crop» в пути, его
 * idle тоже) — не покой: перенос заменил бы карточкой ту самую картинку, которую сейчас обрезают.
 */
export function isCanvasToolIdle(editor: { getPath: () => string }): boolean {
  const path = editor.getPath();
  if (path.split(".").some((state) => state.includes("crop"))) return false;
  return /(?:^|\.)idle$/.test(path);
}

/** Ждём покоя инструмента (не рвём жест пользователя): true — можно менять доску, false — редактор больше недоступен
 * (или вышел необязательный timeoutMs). onWait — один раз, если сразу не покой (показать «продолжится, когда…»). */
export async function waitForCanvasIdle(
  isIdle: () => boolean,
  canContinue: () => boolean,
  sleep: (ms: number) => Promise<void>,
  {
    intervalMs = 120,
    onWait,
    timeoutMs = Number.POSITIVE_INFINITY,
  }: { intervalMs?: number; onWait?: () => void; timeoutMs?: number } = {}
): Promise<boolean> {
  for (let waited = 0; ; waited += intervalMs) {
    if (!canContinue()) return false;
    if (isIdle()) return true;
    if (waited >= timeoutMs) return false;
    if (waited === 0) onWait?.();
    // oxlint-disable-next-line no-await-in-loop -- проверка покоя через равные промежутки
    await sleep(intervalMs);
  }
}

/** Стрелки, привязанные к картинке, переходят на карточку с теми же концом и точкой привязки. */
function rebindArrows(editor: TInlineImageEditor, fromShapeId: TLShapeId, toShapeId: TLShapeId) {
  const bindings = editor.getBindingsToShape(fromShapeId, "arrow");
  if (bindings.length === 0) return;
  editor.deleteBindings(bindings);
  editor.createBindings(
    bindings.map((binding) => ({ fromId: binding.fromId, props: binding.props, toId: toShapeId, type: binding.type }))
  );
}

type TApplyDeps<TBinding> = {
  memory: TInlineMoveMemory;
  place: (binding: TBinding, center: VecLike) => Promise<void>;
  release: (binding: TBinding) => void;
};

async function applyMove<TBinding extends { entity_id: string; shape_id: string }>(
  editor: TInlineImageEditor,
  move: TInlineImageMove<TBinding>,
  deps: TApplyDeps<TBinding>
): Promise<boolean> {
  const { target } = move;
  const imageId = target.shapeId as TLShapeId;
  const image = editor.getShape(imageId);
  const bounds = image ? editor.getShapePageBounds(imageId) : undefined;
  // Пока шли загрузки, картинку могли удалить, заблокировать или заменить: тогда её не трогаем.
  const ready = image && bounds && showsInlineImage(editor, target);
  const cardId = (move.kind === "place" ? move.binding.shape_id : move.cardShapeId) as TLShapeId;
  if (move.kind === "reuse") {
    if (!ready || !editor.getShape(cardId)) return false;
  } else {
    if (!ready) {
      deps.release(move.binding);
      return false;
    }
    try {
      await deps.place(move.binding, bounds.center);
    } catch {
      return false; // place сам снимает pending-привязку; картинка и data: остаются
    }
    if (!editor.getShape(cardId)) return false;
    // Картинка лежала в рамке или секции — карточка остаётся там же.
    if (image.parentId.startsWith("shape:")) editor.reparentShapes([cardId], image.parentId);
    deps.memory.cards[target.shapeId] = { assetId: target.asset.assetId, cardShapeId: cardId };
    deps.memory.files[target.asset.assetId] = move.binding.entity_id;
  }
  rebindArrows(editor, imageId, cardId);
  editor.deleteShape(imageId);
  if (editor.getShape(imageId)) return false;
  // Ассет — только если его больше не показывает ни одна картинка (RB13). Через store.remove, а не deleteAssets:
  // tldraw не пишет deleteAssets в историю, и ⌘Z вернул бы картинку без её данных.
  if (!collectInlineImageUses(editor).some((use) => use.assetId === target.asset.assetId))
    editor.store.remove([target.asset.assetId as TLAssetId]);
  return true;
}

/** Шаг 2: одна точка истории на весь перенос — ⌘Z возвращает картинки и неиспользуемые ассеты вместе с их data:.
 * Между шагами только микрозадачи (карточка кладётся синхронно), поэтому ввод пользователя в эту запись не попадает.
 * Живые карточки Хранилища ⌘Z не снимает (как любую проекцию: только «Убрать с холста»); повторный перенос такой
 * картинки только уберёт её (память переносов). Ответ — id перенесённых ассетов и число удалённых неиспользуемых. */
export async function applyInlineImageMoves<TBinding extends { entity_id: string; shape_id: string }>(
  editor: TInlineImageEditor,
  moves: readonly TInlineImageMove<TBinding>[],
  orphanAssetIds: readonly string[],
  deps: TApplyDeps<TBinding>
): Promise<{ moved: string[]; removed: number }> {
  const moved: string[] = [];
  if (moves.length === 0 && orphanAssetIds.length === 0) return { moved, removed: 0 };
  editor.markHistoryStoppingPoint(HISTORY_MARK);
  for (const move of moves) {
    // oxlint-disable-next-line no-await-in-loop -- по одной: следующая картинка проверяется после предыдущей замены
    if (await applyMove(editor, move, deps)) moved.push(move.target.asset.assetId);
  }
  // Неиспользуемые ассеты — в той же точке истории; тот, что снова показывает фигура (например, вернули ⌘Z), остаётся.
  const shown = new Set(collectInlineImageUses(editor).map((use) => use.assetId));
  const orphans = orphanAssetIds.filter((assetId) => !shown.has(assetId));
  if (orphans.length > 0) editor.store.remove(orphans.map((assetId) => assetId as TLAssetId));
  return { moved, removed: orphans.length };
}

/** Итог переноса для уведомления содержимого. */
export function describeInlineMigration(
  result: { attempted: number; errors: readonly string[]; failed: number; moved: number; removed: number },
  t: (key: TPpmTranslationKey) => string
): string {
  return [
    result.attempted > 0 ? fillCanvasTemplate(t("canvas.inline_images_done"), { count: result.moved }) : null,
    result.failed > 0 ? fillCanvasTemplate(t("canvas.inline_images_failed"), { count: result.failed }) : null,
    ...result.errors,
    result.removed > 0 ? fillCanvasTemplate(t("canvas.inline_images_removed"), { count: result.removed }) : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}
