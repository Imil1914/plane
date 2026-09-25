// AF2.1 B6: чек-лист «Сделать задачами» (без дублей при повторе) и перенос старых картинок data: в Хранилище (RB13).
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { getPpmTranslation, type TPpmTranslationKey } from "@ppm/brand";
import {
  CHECKLIST_CONVERT_MAX,
  checklistItemsToConvert,
  checklistTaskName,
  convertChecklistItemsToTasks,
  createChecklistTaskMemory,
  describeChecklistConversion,
  markConvertedItems,
  type TChecklistConversionDeps,
} from "@/components/ppm-canvas/canvas-checklist";
import {
  applyInlineImageMoves,
  collectInlineImageUses,
  dataUrlToFile,
  describeInlineImages,
  describeInlineMigration,
  dismissInlineImages,
  findInlineImageAssets,
  inlineImageFile,
  inlineImageFileName,
  inlineImagesActionable,
  inlineImagesDismissKey,
  inlineMoveStep,
  inlineUploadErrorMessage,
  isCanvasToolIdle,
  isInlineImagesDismissed,
  planInlineImageMigration,
  prepareInlineImageMoves,
  readInlineMoveMemory,
  waitForCanvasIdle,
  writeInlineMoveMemory,
  type TInlineImageEditor,
  type TInlineImageMove,
  type TInlineMoveMemory,
} from "@/components/ppm-canvas/canvas-image-migration";
import { PPM_VAULT_MAX_UPLOAD_BYTES } from "@/components/ppm-canvas/canvas-file-kind";

const read = (name: string) =>
  readFileSync(new URL(`../../core/components/ppm-canvas/${name}`, import.meta.url), "utf8");
const ru = (key: TPpmTranslationKey) => getPpmTranslation("ru", key);
const en = (key: TPpmTranslationKey) => getPpmTranslation("en", key);
const NOW = new Date(2026, 8, 25, 15, 30, 12);
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const GIF = "data:image/gif;base64,R0lGODlh";
const SVG = "data:image/svg+xml;base64,PHN2Zy8+";
const TASK = "77777777-7777-4777-8777-777777777777";

type TFakeBinding = { entity_id: string; shape_id: string };

function conversionDeps(overrides: Partial<TChecklistConversionDeps<TFakeBinding>> = {}) {
  let counter = 0;
  const marked: Record<string, string> = {};
  const deps: TChecklistConversionDeps<TFakeBinding> = {
    bind: vi.fn(async (workItemId: string) => ({ entity_id: workItemId, shape_id: `shape:bind-${workItemId}` })),
    canContinue: () => true,
    create: vi.fn(async ({ name, shapeId }: { name: string; shapeId: string }) => ({
      entity_id: `task-${name}`,
      shape_id: shapeId,
    })),
    isGone: () => false,
    isPlaced: () => false,
    newIds: () => {
      counter += 1;
      return { operationId: `op-${counter}`, shapeId: `shape:new-${counter}` };
    },
    onConverted: (itemId, workItemId) => {
      marked[itemId] = workItemId;
    },
    place: vi.fn(async () => undefined),
    ...overrides,
  };
  return { deps, marked };
}

type TFakeShape = { id: string; isLocked: boolean; parentId: string; props: Record<string, unknown>; type: string };
type TFakeArrowBinding = { fromId: string; id: string; props: Record<string, unknown>; toId: string; type: string };

function createFakeBoard(shapes: TFakeShape[], arrows: TFakeArrowBinding[] = []) {
  const byId = new Map(shapes.map((shape) => [shape.id, shape]));
  const bindings = [...arrows];
  const log: string[] = [];
  const fake = {
    createBindings: (partials: TFakeArrowBinding[]) => {
      log.push(`bind ${partials.map((binding) => `${binding.fromId}→${binding.toId}`).join(",")}`);
      bindings.push(...partials.map((binding, index) => ({ ...binding, id: `binding:new-${index}` })));
    },
    deleteBindings: (list: TFakeArrowBinding[]) => {
      log.push(`unbind ${list.map((binding) => binding.id).join(",")}`);
      for (const binding of list) bindings.splice(bindings.indexOf(binding), 1);
    },
    deleteShape: (id: string) => {
      log.push(`delete ${id}`);
      byId.delete(id);
    },
    getBindingsToShape: (id: string, type: string) =>
      bindings.filter((binding) => binding.toId === id && binding.type === type),
    getCurrentPageId: () => "page:board",
    getPageShapeIds: (pageId: string) =>
      new Set(
        [...byId.values()]
          .filter((shape) => (pageId === "page:other") === shape.id.endsWith("@other"))
          .map((shape) => shape.id)
      ),
    getPages: () => [{ id: "page:board" }, { id: "page:other" }],
    getShape: (id: string) => byId.get(id),
    getShapePageBounds: (id: string) => (byId.has(id) ? { center: { x: 10, y: 20 } } : undefined),
    markHistoryStoppingPoint: (name?: string) => {
      log.push(`stop ${name}`);
      return name ?? "stop";
    },
    reparentShapes: (ids: string[], parentId: string) => log.push(`reparent ${ids.join(",")} → ${parentId}`),
    store: { remove: (ids: string[]) => log.push(`remove ${ids.join(",")}`) },
  };
  return { bindings, byId, editor: fake as unknown as TInlineImageEditor, log };
}

const image = (id: string, assetId: string, extra: Partial<TFakeShape> = {}): TFakeShape => ({
  id,
  isLocked: false,
  parentId: "page:board",
  props: { assetId },
  type: "image",
  ...extra,
});

const emptyMemory = (): TInlineMoveMemory => ({ cards: {}, files: {} });
const onBoard = (ids: string[]) => (shapeId: string) => ids.includes(shapeId);

function fakeStorage() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  } as unknown as Storage;
  return { storage, values };
}

describe("checklist → tasks (AF2.1 B6)", () => {
  it("converts only checked, non-empty items that are not tasks yet", () => {
    const items = [
      { id: "a", text: "Замерить при лампе", checked: true },
      { id: "b", text: "  ", checked: true },
      { id: "c", text: "Спросить Олега", checked: false },
      { id: "d", text: "Эталоны", checked: true, work_item_id: TASK },
    ];
    expect(checklistItemsToConvert(items).map((item) => item.id)).toEqual(["a"]);
    expect(markConvertedItems(items, { a: TASK })[0]).toEqual({ ...items[0], work_item_id: TASK });
    expect(markConvertedItems(items, {})[0]).toBe(items[0]);
    // A link another editor set meanwhile is kept, not overwritten.
    expect(markConvertedItems(items, { d: "88888888-8888-4888-8888-888888888888" })[3]).toBe(items[3]);
  });

  it("names the task by the item text: trimmed, at most 255 characters, emoji kept whole", () => {
    expect(checklistTaskName("  Замерить при лампе  ")).toBe("Замерить при лампе");
    expect(checklistTaskName(`${"я".repeat(254)}😀хвост`)).toBe(`${"я".repeat(254)}😀`);
    expect([...checklistTaskName("x".repeat(300))]).toHaveLength(255);
  });

  it("creates each task once: a card that was not placed is retried by binding the same task", async () => {
    const memory = createChecklistTaskMemory();
    const failing = new Set(["task-B"]);
    const { deps, marked } = conversionDeps({
      place: vi.fn(async (binding: TFakeBinding) => {
        if (failing.has(binding.entity_id)) throw new Error("canvas unavailable");
      }),
    });
    const items = [
      { id: "a", text: "A" },
      { id: "b", text: "B" },
    ];
    const first = await convertChecklistItemsToTasks("shape:list", items, memory, deps);
    expect(first).toEqual({ converted: { a: "task-A" }, failed: [], notAttempted: 0, unplaced: [items[1]] });
    failing.clear();
    const second = await convertChecklistItemsToTasks("shape:list", [items[1]], memory, deps);
    expect(second.converted).toEqual({ b: "task-B" });
    expect(deps.create).toHaveBeenCalledTimes(2);
    expect(deps.bind).toHaveBeenCalledTimes(1);
    expect(deps.bind).toHaveBeenCalledWith("task-B");
    expect(marked).toEqual({ a: "task-A", b: "task-B" });
  });

  it("replays a failed create with the same operation and shape ids, but not after the text changed", async () => {
    const memory = createChecklistTaskMemory();
    let fail = true;
    const create = vi.fn(async ({ name, shapeId }: { name: string; operationId: string; shapeId: string }) => {
      if (fail) throw new Error("timeout");
      return { entity_id: `task-${name}`, shape_id: shapeId };
    });
    const { deps } = conversionDeps({ create });
    const first = await convertChecklistItemsToTasks("shape:list", [{ id: "a", text: "A" }], memory, deps);
    expect(first.failed).toEqual([{ id: "a", text: "A" }]);
    fail = false;
    await convertChecklistItemsToTasks("shape:list", [{ id: "a", text: "A" }], memory, deps);
    expect(create.mock.calls[1][0]).toEqual(create.mock.calls[0][0]);

    fail = true;
    await convertChecklistItemsToTasks("shape:list", [{ id: "c", text: "C" }], memory, deps);
    fail = false;
    await convertChecklistItemsToTasks("shape:list", [{ id: "c", text: "C, уточнено" }], memory, deps);
    const [failedCall, retryCall] = create.mock.calls.slice(-2).map(([request]) => request);
    expect(retryCall.operationId).not.toBe(failedCall.operationId);
    expect(retryCall.shapeId).not.toBe(failedCall.shapeId);
  });

  it("only links a remembered task already on the canvas and forgets a task deleted in Plane", async () => {
    const memory = createChecklistTaskMemory();
    const { deps } = conversionDeps({
      place: vi.fn(async () => {
        throw new Error("canvas unavailable");
      }),
    });
    await convertChecklistItemsToTasks("shape:list", [{ id: "a", text: "A" }], memory, deps);
    const linked = await convertChecklistItemsToTasks("shape:list", [{ id: "a", text: "A" }], memory, {
      ...deps,
      isPlaced: (workItemId) => workItemId === "task-A",
    });
    expect(linked.converted).toEqual({ a: "task-A" });
    expect(deps.bind).not.toHaveBeenCalled();

    const gone = Object.assign(new Error("Задача не найдена"), { code: "WORK_ITEM_NOT_FOUND" });
    await convertChecklistItemsToTasks("shape:list", [{ id: "b", text: "B" }], memory, deps);
    const lost = await convertChecklistItemsToTasks("shape:list", [{ id: "b", text: "B" }], memory, {
      ...deps,
      bind: vi.fn(async () => {
        throw gone;
      }),
      isGone: (error) => error === gone,
    });
    expect(lost.failed).toEqual([{ id: "b", text: "B" }]);
    const recreated = await convertChecklistItemsToTasks("shape:list", [{ id: "b", text: "B" }], memory, {
      ...deps,
      place: vi.fn(async () => undefined),
    });
    expect(recreated.converted).toEqual({ b: "task-B" });
    expect(deps.create).toHaveBeenCalledTimes(3);
  });

  it("stops when the list is gone, skips items in flight and converts at most 20 per click", async () => {
    const memory = createChecklistTaskMemory();
    memory.inFlight.add("shape:list:b");
    let checks = 2;
    const { deps } = conversionDeps({ canContinue: () => checks-- > 0 });
    const items = ["a", "b", "c", "d"].map((id) => ({ id, text: id.toUpperCase() }));
    expect(await convertChecklistItemsToTasks("shape:list", items, memory, deps)).toEqual({
      converted: { a: "task-A" },
      failed: [],
      notAttempted: 3,
      unplaced: [],
    });

    const many = Array.from({ length: CHECKLIST_CONVERT_MAX + 3 }, (_, index) => ({
      id: `i${index}`,
      text: `T${index}`,
    }));
    const capped = await convertChecklistItemsToTasks(
      "shape:list-2",
      many,
      createChecklistTaskMemory(),
      conversionDeps().deps
    );
    expect(Object.keys(capped.converted)).toHaveLength(CHECKLIST_CONVERT_MAX);
    expect(capped.notAttempted).toBe(3);
  });

  it("says which items became tasks and which did not, with the quotes of the interface language", () => {
    expect(
      describeChecklistConversion({ converted: { a: "t1", b: "t2" }, failed: [], notAttempted: 0, unplaced: [] }, 2, ru)
    ).toBe("Создано задач: 2");
    expect(
      describeChecklistConversion(
        {
          converted: { a: "t1" },
          failed: [{ id: "c", text: "Эталоны" }],
          notAttempted: 1,
          unplaced: [{ id: "b", text: "Спросить Олега" }],
        },
        4,
        ru
      )
    ).toBe(
      "Стали задачами: 1 из 4. Задачи созданы, но не добавлены на холст: «Спросить Олега». Не удалось создать: " +
        "«Эталоны». Нажмите «Сделать задачами» ещё раз — дублей не будет."
    );
    const names = ["Первый", "Второй", "Третий", "Четвёртый"].map((text, index) => ({ id: `${index}`, text }));
    names[0].text = "Очень длинный пункт, который не помещается в уведомление целиком";
    expect(
      describeChecklistConversion({ converted: {}, failed: names, notAttempted: 0, unplaced: [] }, 4, ru)
    ).toContain("Не удалось создать: «Очень длинный пункт, который не помещает…», «Второй», «Третий», ….");
    expect(
      describeChecklistConversion(
        { converted: { a: "t1" }, failed: [{ id: "c", text: "Etalons" }], notAttempted: 0, unplaced: [] },
        2,
        en
      )
    ).toBe(
      "Turned into tasks: 1 of 2. Could not create: “Etalons”. Click “Make tasks” again — nothing will be duplicated."
    );
  });
});

describe("inline data: images → Vault (AF2.1 B6, RB13)", () => {
  it("finds data: images, sizes them and checks their bytes against the Vault formats and limit", () => {
    const big = `data:image/png;base64,iVBORw0KGgoA${"AAAA".repeat(1_747_624)}`;
    const found = findInlineImageAssets([
      { id: "asset:1", type: "image", props: { mimeType: "image/png", name: "image.png", src: PNG } },
      { id: "asset:2", type: "image", props: { src: "https://example.org/x.png" } },
      { id: "asset:3", type: "image", props: { src: GIF } },
      { id: "asset:4", type: "video", props: { src: "data:video/mp4;base64,AAAA" } },
      { id: "asset:5", type: "image", props: { name: "logo.svg", src: SVG } },
      { id: "asset:6", type: "image", props: { name: "photo.png", src: "data:image/png;base64,R0lGODlh" } },
      { id: "asset:7", type: "image", props: { name: "huge.png", src: big } },
    ]);
    expect(found.map(({ src: _src, ...rest }) => rest)).toEqual([
      {
        assetId: "asset:1",
        bytes: 8,
        extension: "png",
        mime: "image/png",
        name: "image.png",
        reason: null,
        supported: true,
      },
      { assetId: "asset:3", bytes: 6, extension: "gif", mime: "image/gif", name: "", reason: null, supported: true },
      {
        assetId: "asset:5",
        bytes: 6,
        extension: "",
        mime: "image/svg+xml",
        name: "logo.svg",
        reason: "format",
        supported: false,
      },
      {
        assetId: "asset:6",
        bytes: 6,
        extension: "gif",
        mime: "image/png",
        name: "photo.png",
        reason: null,
        supported: true,
      },
      {
        assetId: "asset:7",
        bytes: 5_242_881,
        extension: "png",
        mime: "image/png",
        name: "huge.png",
        reason: "size",
        supported: false,
      },
    ]);
    expect(found[0].src).toBe(PNG);
    expect(PPM_VAULT_MAX_UPLOAD_BYTES).toBe(5 * 1024 * 1024);
    // The editor narrows the limit to the instance's (useFileSize), as paste does.
    expect(findInlineImageAssets([{ id: "asset:1", type: "image", props: { src: PNG } }], 4)[0].reason).toBe("size");
  });

  it("turns a data: URL back into the original bytes, typed by the byte signature", async () => {
    const file = dataUrlToFile(PNG, "Вставка-2026-09-25-153012.png");
    expect(file.name).toBe("Вставка-2026-09-25-153012.png");
    expect(file.type).toBe("image/png");
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const [mislabelled] = findInlineImageAssets([
      { id: "asset:6", type: "image", props: { name: "photo.png", src: "data:image/png;base64,R0lGODlh" } },
    ]);
    const upload = inlineImageFile(mislabelled, NOW, 1);
    expect([upload.name, upload.type]).toEqual(["photo.gif", "image/gif"]);
  });

  it("names the Vault file like a paste and makes the extension match the bytes", () => {
    const assets = findInlineImageAssets([
      { id: "asset:1", type: "image", props: { name: "image.png", src: PNG } },
      { id: "asset:2", type: "image", props: { name: "Схема стенда.png", src: PNG } },
      { id: "asset:3", type: "image", props: { name: "photo.png", src: GIF } },
      { id: "asset:4", type: "image", props: { name: "a/b\\c.png", src: PNG } },
    ]);
    expect(inlineImageFileName(assets[0], NOW, 1)).toBe("Вставка-2026-09-25-153012.png");
    expect(inlineImageFileName(assets[0], NOW, 2)).toBe("Вставка-2026-09-25-153012 (2).png");
    expect(inlineImageFileName(assets[1], NOW, 3)).toBe("Схема стенда.png");
    expect(inlineImageFileName(assets[2], NOW, 1)).toBe("photo.gif");
    expect(inlineImageFileName(assets[3], NOW, 1)).toBe("a-b-c.png");
  });

  it("plans one card per stored picture on this page and removes data: that no shape shows", () => {
    const { editor } = createFakeBoard([
      image("shape:s0", "asset:shared", { isLocked: true }),
      image("shape:s1", "asset:shared"),
      image("shape:s2", "asset:shared"),
      image("shape:l", "asset:locked", { isLocked: true }),
      image("shape:o@other", "asset:other-page"),
      image("shape:v", "asset:svg"),
      { id: "shape:note", isLocked: false, parentId: "page:board", props: {}, type: "ppm-canvas-node" },
    ]);
    const uses = collectInlineImageUses(editor);
    expect(uses.find((use) => use.shapeId === "shape:o@other")).toEqual({
      assetId: "asset:other-page",
      locked: false,
      onCurrentPage: false,
      shapeId: "shape:o@other",
    });
    const assets = findInlineImageAssets(
      ["asset:shared", "asset:locked", "asset:other-page", "asset:orphan"]
        .map((id) => ({ id, type: "image", props: { src: PNG } }))
        .concat([
          { id: "asset:svg", type: "image", props: { src: SVG } },
          { id: "asset:orphan-svg", type: "image", props: { src: SVG } },
        ])
    );
    const plan = planInlineImageMigration(assets, uses);
    expect(plan.targets.map((target) => [target.asset.assetId, target.shapeId])).toEqual([
      ["asset:shared", "shape:s1"],
    ]);
    // Shown on another tldraw page — neither moved nor removed; unused (any format) — removed from the board.
    expect(plan.orphans.map((asset) => asset.assetId)).toEqual(["asset:orphan", "asset:orphan-svg"]);
    expect(plan).toMatchObject({ locked: 1, tooLarge: 0, unsupported: 1 });
    expect(describeInlineImages(plan, ru, (bytes) => `${bytes} Б`)).toBe(
      "Картинок внутри доски: 1 (8 Б). Перенести их в Хранилище, чтобы доска сохранялась быстрее? " +
        "Неиспользуемые встроенные картинки: 2 (14 Б) — будут удалены с доски. " +
        "Остаются на доске: 1 — Хранилище не принимает их формат (например, SVG). " +
        "Остаются на доске: 1 — заблокированы; разблокируйте, чтобы перенести."
    );
    // Only unused data: left — the notice still appears, it has something to do.
    const onlyOrphans = planInlineImageMigration(assets.slice(3, 4), []);
    expect(inlineImagesActionable(onlyOrphans)).toBe(true);
    expect(inlineImagesActionable({ ...onlyOrphans, orphans: [], unsupported: 1 })).toBe(false);
  });

  it("decides per picture: reuse the card after ⌘Z, bind a file already in the Vault, or upload", () => {
    const [asset] = findInlineImageAssets([{ id: "asset:1", type: "image", props: { src: PNG } }]);
    const memory: TInlineMoveMemory = {
      cards: { "shape:img": { assetId: "asset:1", cardShapeId: "shape:card" } },
      files: { "asset:1": "entry:1" },
    };
    // ⌘Z brought the picture back and its card is still there: only the picture goes, no second card or file.
    expect(inlineMoveStep({ asset, shapeId: "shape:img" }, memory, onBoard(["shape:card"]))).toEqual({
      cardShapeId: "shape:card",
      step: "reuse",
    });
    // The card was removed from the canvas, or another picture shows the same asset: bind the file already uploaded.
    expect(inlineMoveStep({ asset, shapeId: "shape:img" }, memory, onBoard([]))).toEqual({
      entryId: "entry:1",
      step: "bind",
    });
    expect(inlineMoveStep({ asset, shapeId: "shape:img2" }, memory, onBoard(["shape:card"]))).toEqual({
      entryId: "entry:1",
      step: "bind",
    });
    expect(inlineMoveStep({ asset, shapeId: "shape:img" }, emptyMemory(), onBoard([]))).toEqual({ step: "upload" });
  });

  it("keeps the move memory per board in the tab, so a reload does not duplicate", () => {
    const { storage } = fakeStorage();
    const memory: TInlineMoveMemory = {
      cards: { "shape:img": { assetId: "asset:1", cardShapeId: "shape:card" } },
      files: { "asset:1": "entry:1" },
    };
    writeInlineMoveMemory(storage, "b-1", memory);
    expect(readInlineMoveMemory(storage, "b-1")).toEqual(memory);
    expect(readInlineMoveMemory(storage, "b-2")).toEqual(emptyMemory());
    storage.setItem("ppm-canvas-inline-images-moved:b-3", "{broken");
    expect(readInlineMoveMemory(storage, "b-3")).toEqual(emptyMemory());
    storage.setItem("ppm-canvas-inline-images-moved:b-4", JSON.stringify({ cards: { x: 1 }, files: { a: "e" } }));
    expect(readInlineMoveMemory(storage, "b-4")).toEqual({ cards: {}, files: { a: "e" } });
    expect(readInlineMoveMemory(undefined, "b-1")).toEqual(emptyMemory());
  });

  it("uploads before touching the board, skips pictures that are gone and never uploads twice", async () => {
    const { byId, editor } = createFakeBoard([
      image("shape:0", "asset:1"),
      image("shape:1", "asset:2"),
      image("shape:2", "asset:3"),
      image("shape:3", "asset:4"),
    ]);
    const targets = findInlineImageAssets(
      ["asset:1", "asset:2", "asset:3", "asset:4"].map((id) => ({
        id,
        type: "image",
        props: { name: "image.png", src: PNG },
      }))
    ).map((asset, index) => ({ asset, shapeId: `shape:${index}` }));
    byId.delete("shape:2"); // removed after the notice was shown: no upload for it
    const memory = emptyMemory();
    const upload = vi.fn(async (file: File) => {
      if (file.name.includes("(2)")) throw Object.assign(new Error("Network Error"), { code: undefined });
      return { id: `entry:${file.name}` };
    });
    const bind = vi.fn(async (entryId: string) => ({ entity_id: entryId, shape_id: `shape:card-${entryId}` }));
    const deps = {
      bind,
      canContinue: () => true,
      describeError: (error: unknown, name: string) =>
        inlineUploadErrorMessage(error, name, ru, PPM_VAULT_MAX_UPLOAD_BYTES),
      file: (target: (typeof targets)[number], ordinal: number) => inlineImageFile(target.asset, NOW, ordinal),
      isGone: () => false,
      memory,
      upload,
    };
    const first = await prepareInlineImageMoves(editor, targets, deps);
    expect(upload.mock.calls.map(([file]) => file.name)).toEqual([
      "Вставка-2026-09-25-153012.png",
      "Вставка-2026-09-25-153012 (2).png",
      "Вставка-2026-09-25-153012 (3).png",
    ]);
    expect(first.moves.map((move) => (move.kind === "place" ? move.binding.entity_id : move.kind))).toEqual([
      "entry:Вставка-2026-09-25-153012.png",
      "entry:Вставка-2026-09-25-153012 (3).png",
    ]);
    // A raw «Network Error» becomes the interface's own words.
    expect(first.errors).toEqual(["Не удалось загрузить файл в Хранилище."]);
    expect(memory.files).toEqual({
      "asset:1": "entry:Вставка-2026-09-25-153012.png",
      "asset:4": "entry:Вставка-2026-09-25-153012 (3).png",
    });
    upload.mockClear();
    const retry = await prepareInlineImageMoves(editor, [targets[0]], deps);
    expect(upload).not.toHaveBeenCalled();
    expect(retry.moves).toHaveLength(1);
    // The remembered file was deleted from the Vault: upload once more, then bind.
    const gone = Object.assign(new Error("gone"), { code: "CONTENT_SOURCE_NOT_FOUND" });
    let firstBind = true;
    const rebound = await prepareInlineImageMoves(editor, [targets[0]], {
      ...deps,
      bind: vi.fn(async (entryId: string) => {
        if (firstBind) {
          firstBind = false;
          throw gone;
        }
        return { entity_id: entryId, shape_id: `shape:card-${entryId}` };
      }),
      isGone: (error: unknown) => error === gone,
    });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(rebound.moves).toHaveLength(1);
    // The card is already on the board (⌘Z brought the picture back): neither upload nor bind.
    memory.cards["shape:0"] = { assetId: "asset:1", cardShapeId: "shape:card" };
    byId.set("shape:card", { id: "shape:card", isLocked: false, parentId: "page:board", props: {}, type: "card" });
    upload.mockClear();
    bind.mockClear();
    const reused = await prepareInlineImageMoves(editor, [targets[0]], deps);
    expect(reused.moves).toEqual([{ cardShapeId: "shape:card", kind: "reuse", target: targets[0] }]);
    expect(upload).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
    const stopped = await prepareInlineImageMoves(editor, targets, { ...deps, canContinue: () => false });
    expect(stopped.moves).toEqual([]);
  });

  it("explains upload refusals in the interface language", () => {
    const tooLarge = { code: "VAULT_FILE_TOO_LARGE" };
    expect(inlineUploadErrorMessage(tooLarge, "Схема.png", ru, PPM_VAULT_MAX_UPLOAD_BYTES)).toBe(
      "Файл «Схема.png» больше 5 МБ — Хранилище принимает файлы до 5 МБ."
    );
    expect(inlineUploadErrorMessage(tooLarge, "Scheme.png", en, PPM_VAULT_MAX_UPLOAD_BYTES)).toBe(
      "File “Scheme.png” is over 5 MB — Knowledge accepts files up to 5 MB."
    );
    expect(inlineUploadErrorMessage(new Error("Network Error"), "x.png", en, PPM_VAULT_MAX_UPLOAD_BYTES)).toBe(
      "Could not upload the file to Knowledge."
    );
  });

  it("waits for the select tool to be idle before changing the board", async () => {
    const sleep = vi.fn(async () => undefined);
    let checks = 0;
    expect(
      await waitForCanvasIdle(
        () => ++checks > 3,
        () => true,
        sleep
      )
    ).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(
      await waitForCanvasIdle(
        () => false,
        () => true,
        sleep,
        { intervalMs: 100, timeoutMs: 300 }
      )
    ).toBe(false);
    expect(
      await waitForCanvasIdle(
        () => true,
        () => false,
        sleep
      )
    ).toBe(false);
    // No deadline by default: it waits for the user to finish (the hint is shown once), and stops if the editor goes.
    const onWait = vi.fn();
    let busy = 5;
    expect(
      await waitForCanvasIdle(
        () => busy-- <= 0,
        () => true,
        sleep,
        { onWait }
      )
    ).toBe(true);
    expect(onWait).toHaveBeenCalledTimes(1);
    let alive = 3;
    expect(
      await waitForCanvasIdle(
        () => false,
        () => alive-- > 0,
        sleep
      )
    ).toBe(false);
  });

  it("moves in one history step: re-binds arrows, removes unused data: and keeps pictures whose card failed", async () => {
    const { bindings, byId, editor, log } = createFakeBoard(
      [
        image("shape:img1", "asset:1"),
        image("shape:img2", "asset:2", { parentId: "shape:frame" }),
        image("shape:img3", "asset:2"),
        image("shape:img4", "asset:3"),
        image("shape:img5", "asset:5"),
        { id: "shape:old-card", isLocked: false, parentId: "page:board", props: {}, type: "card" },
        image("shape:shown-again", "asset:orphan-2"),
      ],
      [
        {
          fromId: "shape:arrow",
          id: "binding:1",
          props: { isExact: false, isPrecise: true, normalizedAnchor: { x: 0.2, y: 0.8 }, terminal: "end" },
          toId: "shape:img1",
          type: "arrow",
        },
      ]
    );
    const assets = findInlineImageAssets(
      ["asset:1", "asset:2", "asset:3", "asset:4", "asset:5"].map((id) => ({ id, type: "image", props: { src: PNG } }))
    );
    const memory = emptyMemory();
    type TBinding = { entity_id: string; shape_id: string };
    const moves: TInlineImageMove<TBinding>[] = [
      {
        binding: { entity_id: "entry:1", shape_id: "shape:card1" },
        kind: "place",
        target: { asset: assets[0], shapeId: "shape:img1" },
      },
      {
        binding: { entity_id: "entry:2", shape_id: "shape:card2" },
        kind: "place",
        target: { asset: assets[1], shapeId: "shape:img2" },
      },
      {
        binding: { entity_id: "entry:3", shape_id: "shape:card3" },
        kind: "place",
        target: { asset: assets[2], shapeId: "shape:img4" },
      },
      {
        binding: { entity_id: "entry:4", shape_id: "shape:card4" },
        kind: "place",
        target: { asset: assets[3], shapeId: "shape:gone" },
      },
      { cardShapeId: "shape:old-card", kind: "reuse", target: { asset: assets[4], shapeId: "shape:img5" } },
    ];
    const place = vi.fn(async (binding: TBinding, center: { x: number; y: number }) => {
      if (binding.shape_id === "shape:card3") throw new Error("canvas unavailable");
      byId.set(binding.shape_id, {
        id: binding.shape_id,
        isLocked: false,
        parentId: "page:board",
        props: {},
        type: "card",
      });
      log.push(`card ${binding.shape_id} at ${center.x},${center.y}`);
    });
    const release = vi.fn();
    expect(
      await applyInlineImageMoves(editor, moves, ["asset:orphan-1", "asset:orphan-2"], { memory, place, release })
    ).toEqual({ moved: ["asset:1", "asset:2", "asset:5"], removed: 1 });
    expect(log).toEqual([
      "stop ppm move inline images",
      "card shape:card1 at 10,20",
      "unbind binding:1",
      "bind shape:arrow→shape:card1",
      "delete shape:img1",
      "remove asset:1",
      "card shape:card2 at 10,20",
      "reparent shape:card2 → shape:frame",
      "delete shape:img2",
      "delete shape:img5",
      "remove asset:5",
      // asset:orphan-2 is shown again (e.g. ⌘Z) — it stays.
      "remove asset:orphan-1",
    ]);
    expect(bindings).toEqual([
      expect.objectContaining({
        fromId: "shape:arrow",
        props: expect.objectContaining({ normalizedAnchor: { x: 0.2, y: 0.8 }, terminal: "end" }),
        toId: "shape:card1",
      }),
    ]);
    expect(byId.has("shape:img4")).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith({ entity_id: "entry:4", shape_id: "shape:card4" });
    // Remembered for a later «Перенести» after ⌘Z (and kept after success, not wiped).
    expect(memory).toEqual({
      cards: {
        "shape:img1": { assetId: "asset:1", cardShapeId: "shape:card1" },
        "shape:img2": { assetId: "asset:2", cardShapeId: "shape:card2" },
      },
      files: { "asset:1": "entry:1", "asset:2": "entry:2" },
    });

    const idle = createFakeBoard([]);
    expect(await applyInlineImageMoves(idle.editor, [], [], { memory, place, release })).toEqual({
      moved: [],
      removed: 0,
    });
    expect(idle.log).toEqual([]);
  });

  it("remembers «Не сейчас» per board in the tab and survives blocked storage", () => {
    const { storage } = fakeStorage();
    expect(inlineImagesDismissKey("b-1")).toBe("ppm-canvas-inline-images-dismissed:b-1");
    expect(isInlineImagesDismissed(storage, "b-1")).toBe(false);
    dismissInlineImages(storage, "b-1");
    expect(isInlineImagesDismissed(storage, "b-1")).toBe(true);
    expect(isInlineImagesDismissed(storage, "b-2")).toBe(false);
    const blocked = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
    } as unknown as Storage;
    expect(() => dismissInlineImages(blocked, "b-1")).not.toThrow();
    expect(isInlineImagesDismissed(blocked, "b-1")).toBe(false);
    expect(isInlineImagesDismissed(undefined, "b-1")).toBe(false);
  });

  it("reports the result of the move", () => {
    expect(describeInlineMigration({ attempted: 3, errors: [], failed: 0, moved: 3, removed: 0 }, ru)).toBe(
      "Перенесено в Хранилище: 3."
    );
    expect(
      describeInlineMigration(
        { attempted: 3, errors: ["Не удалось загрузить файл в Хранилище."], failed: 1, moved: 2, removed: 2 },
        ru
      )
    ).toBe(
      "Перенесено в Хранилище: 2. Не удалось перенести: 1 — они остались на доске. " +
        "Не удалось загрузить файл в Хранилище. Удалено неиспользуемых встроенных картинок: 2."
    );
    expect(describeInlineMigration({ attempted: 0, errors: [], failed: 0, moved: 0, removed: 2 }, ru)).toBe(
      "Удалено неиспользуемых встроенных картинок: 2."
    );
  });
});

describe("wiring and strings (AF2.1 B6)", () => {
  it("wires the checklist button and the confirmation notice for editors under v2 only", () => {
    const shapeSource = read("shape.tsx");
    expect(shapeSource).toContain("checklistItemsToConvert(node.items)");
    expect(shapeSource).toMatch(/grammarV2 && !readonly && contentActions\.canEdit && pending\.length > 0/);
    const editorSource = read("editor.tsx");
    expect(editorSource).toContain("isInlineImagesDismissed(getCanvasSessionStorage(), boardId)");
    expect(editorSource).toMatch(/grammarV2 && effectiveCanEdit && inlineImages/);
    // A board over the save limit (sync error) is exactly the one that needs the move.
    expect(editorSource).toContain('syncStatus !== "saved" && syncStatus !== "error"');
    expect(editorSource).toMatch(/applyInlineImageMoves\(\s*activeEditor,/);
    // The plan is read again at click time; the board changes only when the select tool is idle.
    expect(editorSource).toMatch(
      /const migrateInlineImages = useCallback\(async \(\) => \{[\s\S]{0,400}readInlineImages\(activeEditor\)/
    );
    // Финальная волна (B6): покой — «*.idle» любого инструмента (Рука, Перо…), не только «Выбора».
    expect(editorSource).toContain("() => isCanvasToolIdle(activeEditor),");
    expect(editorSource).not.toContain('activeEditor.isIn("select.idle")');
    // «Сделать задачами» is its own undo step, not merged with earlier checklist edits.
    expect(editorSource).toContain('markHistoryStoppingPoint("ppm checklist to tasks")');
    // tldraw keeps deleteAssets out of the undo history: the data: asset goes through the recorded store.remove.
    expect(read("canvas-image-migration.ts")).toContain("editor.store.remove(");
    expect(editorSource).not.toContain("deleteAssets(");
  });

  it("names the actions in both languages", () => {
    expect(getPpmTranslation("ru", "canvas.checklist_make_tasks").replace("{count}", "2")).toBe("Сделать задачами · 2");
    expect(getPpmTranslation("ru", "canvas.inline_images_move")).toBe("Перенести в Хранилище");
    expect(getPpmTranslation("en", "canvas.inline_images_later")).toBe("Not now");
    expect(getPpmTranslation("ru", "canvas.inline_images_remove_unused")).toBe("Удалить неиспользуемые");
    expect(getPpmTranslation("ru", "canvas.inline_images_waiting")).toBe(
      "Перенос продолжится, когда закончите действие на холсте…"
    );
  });
});

// Финальная волна (отложенное B6): перенос ждёт покоя любого инструмента, а не только «Выбора».
describe("inline image move waits for any idle tool (final wave, B6)", () => {
  it("treats the idle state of every tool as calm, and gestures or text editing as busy", () => {
    for (const path of ["select.idle", "hand.idle", "draw.idle", "geo.idle"])
      expect(isCanvasToolIdle({ getPath: () => path }), path).toBe(true);
    for (const path of [
      "select.translating",
      "select.editing_shape",
      "select.brushing",
      "draw.drawing",
      "hand.dragging",
      "select.idleish",
    ])
      expect(isCanvasToolIdle({ getPath: () => path }), path).toBe(false);
  });

  // Раунд 2 (m-6): режим обрезки картинки — не покой, даже его «idle»: перенос заменил бы карточкой ту самую
  // картинку, которую сейчас обрезают. Состояния tldraw 3.15: select.crop.{idle,pointing_crop,translating_crop,
  // pointing_crop_handle,cropping}; «*.crop*» с idle на конце — тоже.
  it("never treats image-crop mode as calm, its idle included", () => {
    for (const path of [
      "select.crop.idle",
      "select.crop.pointing_crop",
      "select.crop.translating_crop",
      "select.crop.pointing_crop_handle",
      "select.crop.cropping",
      "select.cropping",
      "image.crop.idle",
      "select.crop_tool.idle",
    ])
      expect(isCanvasToolIdle({ getPath: () => path }), path).toBe(false);
  });

  it("says «с доски» for unused images in Russian", () => {
    expect(ru("canvas.inline_images_orphans")).toBe(
      "Неиспользуемые встроенные картинки: {count} ({size}) — будут удалены с доски."
    );
  });
});
