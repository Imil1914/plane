import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "tldraw";
import { getPpmTranslation } from "@ppm/brand";
import {
  attachFilesToWorkItem,
  attachmentFingerprint,
  dropHintKey,
  pastedFileName,
  registerPpmCanvasExternalContent,
  type TPpmCanvasExternalContentDeps,
  type TPpmWorkItemAttachDeps,
} from "@/components/ppm-canvas/canvas-external-content";
import { isVaultUploadable, PPM_VAULT_MAX_UPLOAD_BYTES } from "@/components/ppm-canvas/canvas-file-kind";

const editorSource = readFileSync(new URL("../../core/components/ppm-canvas/editor.tsx", import.meta.url), "utf8");
const NOW = new Date(2026, 8, 25, 15, 30, 12);
const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", { type: "image/png" });

function createFakeEditor() {
  const previous = {
    files: vi.fn(async () => undefined),
    "svg-text": vi.fn(async () => undefined),
    url: vi.fn(async () => undefined),
  };
  const handlers: Record<string, ((info: unknown) => unknown) | null> = { ...previous };
  const fake = {
    externalContentHandlers: handlers,
    getViewportPageBounds: () => ({ center: { x: 500, y: 300 } }),
    putExternalContent: async (info: { type: string }) => handlers[info.type]?.(info),
    registerExternalContentHandler(type: string, handler: ((info: unknown) => unknown) | null) {
      handlers[type] = handler;
      return fake;
    },
  };
  return { editor: fake as unknown as Editor, handlers, previous };
}

function createDeps(overrides: Partial<TPpmCanvasExternalContentDeps> = {}) {
  const notices: string[] = [];
  const deps: TPpmCanvasExternalContentDeps = {
    canEdit: true,
    createLinkNote: vi.fn(),
    grammarV2: true,
    isActive: true,
    maxUploadBytes: PPM_VAULT_MAX_UPLOAD_BYTES,
    notify: (message) => notices.push(message),
    now: () => NOW,
    placeVaultEntry: vi.fn(async () => undefined),
    t: (key) => getPpmTranslation("ru", key),
    uploadToVault: vi.fn(async (file: File) => ({ id: `entry:${file.name}` })),
    ...overrides,
  };
  return { deps, notices };
}

afterEach(() => vi.restoreAllMocks());

describe("paste, drop and ⌘U into the Vault (AF2.1 B4)", () => {
  it("gives pasted files a readable name and keeps real names", () => {
    expect(pastedFileName({ name: "image.png", type: "image/png" }, NOW)).toBe("Вставка-2026-09-25-153012.png");
    expect(pastedFileName({ name: "tldrawFile", type: "image/jpeg" }, NOW)).toBe("Вставка-2026-09-25-153012.jpg");
    expect(pastedFileName({ name: "Схема захвата.pdf", type: "application/pdf" }, NOW)).toBe("Схема захвата.pdf");
    expect(isVaultUploadable("Вставка-2026-09-25-153012.png")).toBe(true);
    // Раунд 1: формат — зеркало сервера (services.py/formats.py). GIF и исходный код теперь приняты, SVG и видео — нет.
    expect(isVaultUploadable("anim.gif")).toBe(true);
    expect(isVaultUploadable("script.py")).toBe(true);
    expect(isVaultUploadable("image.svg")).toBe(false);
    expect(isVaultUploadable("clip.mp4")).toBe(false);
  });

  it("uploads pasted files to the Vault and places live cards at the paste point", async () => {
    const { editor } = createFakeEditor();
    const { deps, notices } = createDeps();
    registerPpmCanvasExternalContent(editor, () => deps);
    await editor.putExternalContent({ type: "files", files: [png()], point: { x: 10, y: 20 } });
    expect(vi.mocked(deps.uploadToVault).mock.calls[0][0].name).toBe("Вставка-2026-09-25-153012.png");
    expect(deps.placeVaultEntry).toHaveBeenCalledWith("entry:Вставка-2026-09-25-153012.png", { x: 10, y: 20 }, 0);
    expect(notices.at(-1)).toContain("Сохранено в Хранилище: 1");
  });

  it("uploads GIF and source-code files (round 1: format list mirrors the server)", async () => {
    const { editor } = createFakeEditor();
    const { deps } = createDeps();
    registerPpmCanvasExternalContent(editor, () => deps);
    const gif = new File(["GIF89a"], "anim.gif", { type: "image/gif" });
    const code = new File(["print(1)"], "script.py", { type: "text/x-python" });
    await editor.putExternalContent({ type: "files", files: [gif, code] });
    expect(vi.mocked(deps.uploadToVault).mock.calls.map(([file]) => file.name)).toEqual(["anim.gif", "script.py"]);
  });

  it("retries a name conflict with a numbered suffix", async () => {
    const { editor } = createFakeEditor();
    const conflict = Object.assign(new Error("Материал с таким именем уже существует."), {
      code: "VAULT_NAME_CONFLICT",
    });
    const uploadToVault = vi
      .fn<(file: File) => Promise<{ id: string }>>()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ id: "entry-2" });
    const { deps } = createDeps({ uploadToVault });
    registerPpmCanvasExternalContent(editor, () => deps);
    await editor.putExternalContent({ type: "files", files: [png()] });
    expect(uploadToVault.mock.calls.map(([file]) => file.name)).toEqual([
      "Вставка-2026-09-25-153012.png",
      "Вставка-2026-09-25-153012 (2).png",
    ]);
    expect(deps.placeVaultEntry).toHaveBeenCalledWith("entry-2", { x: 500, y: 300 }, 0);
  });

  it("uses the server's suggested_name for a conflict retry instead of guessing a suffix", async () => {
    const { editor } = createFakeEditor();
    const conflict = Object.assign(new Error("Материал с таким именем уже существует."), {
      code: "VAULT_NAME_CONFLICT",
      details: { suggested_name: "Вставка-2026-09-25-153012 (7).png" },
    });
    const uploadToVault = vi
      .fn<(file: File) => Promise<{ id: string }>>()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ id: "entry-7" });
    const { deps } = createDeps({ uploadToVault });
    registerPpmCanvasExternalContent(editor, () => deps);
    await editor.putExternalContent({ type: "files", files: [png()] });
    expect(uploadToVault.mock.calls.map(([file]) => file.name)).toEqual([
      "Вставка-2026-09-25-153012.png",
      "Вставка-2026-09-25-153012 (7).png",
    ]);
  });

  it("rejects formats the Vault does not accept with a truthful Russian notice", async () => {
    const { editor } = createFakeEditor();
    const { deps, notices } = createDeps();
    registerPpmCanvasExternalContent(editor, () => deps);
    await editor.putExternalContent({ type: "files", files: [new File(["clip"], "clip.mp4", { type: "video/mp4" })] });
    expect(deps.uploadToVault).not.toHaveBeenCalled();
    expect(notices.join(" ")).toContain("clip.mp4");
    expect(notices.join(" ")).toContain("Хранилище не принимает");
    expect(notices.join(" ")).toContain("видео не принимаются");
  });

  it("refuses a file over the size limit before uploading anything", async () => {
    const { editor } = createFakeEditor();
    const { deps, notices } = createDeps({ maxUploadBytes: 2 });
    registerPpmCanvasExternalContent(editor, () => deps);
    await editor.putExternalContent({ type: "files", files: [png()] });
    expect(deps.uploadToVault).not.toHaveBeenCalled();
    expect(deps.placeVaultEntry).not.toHaveBeenCalled();
    expect(notices.join(" ")).toContain("Вставка-2026-09-25-153012.png");
    expect(notices.join(" ")).toContain("больше 1 МБ");
  });

  it("reports per-file upload errors by name, and counts saved-but-not-placed separately", async () => {
    const { editor } = createFakeEditor();
    const failing = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "Схема.png", { type: "image/png" });
    const notPlaced = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "Карта.png", { type: "image/png" });
    const uploadToVault = vi.fn(async (file: File) => {
      if (file.name === "Схема.png") throw new Error("Хранилище недоступно.");
      return { id: `entry:${file.name}` };
    });
    const placeVaultEntry = vi.fn(async (entryId: string) => {
      if (entryId === "entry:Карта.png") throw new Error("boom");
    });
    const { deps, notices } = createDeps({ placeVaultEntry, uploadToVault });
    registerPpmCanvasExternalContent(editor, () => deps);
    await editor.putExternalContent({ type: "files", files: [failing, notPlaced, png()] });
    const notice = notices.join(" ");
    expect(notice).toContain("Сохранено в Хранилище: 1");
    expect(notice).toContain("Сохранено в Хранилище, но не добавлено на холст: 1");
    expect(notice).toContain("«Схема.png»: Хранилище недоступно.");
  });

  it("says how many files were skipped beyond the per-drop limit", async () => {
    const { editor } = createFakeEditor();
    const { deps, notices } = createDeps();
    registerPpmCanvasExternalContent(editor, () => deps);
    const files = Array.from(
      { length: 22 },
      (_, index) => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], `Кадр-${index}.png`, { type: "image/png" })
    );
    await editor.putExternalContent({ type: "files", files });
    expect(deps.uploadToVault).toHaveBeenCalledTimes(20);
    expect(notices.join(" ")).toContain("Не вставлено: 2");
  });

  it("keeps the v1 behaviour: delegates to the default tldraw handlers", async () => {
    const { editor, previous } = createFakeEditor();
    const { deps } = createDeps({ grammarV2: false });
    registerPpmCanvasExternalContent(editor, () => deps);
    const info = { type: "files" as const, files: [png()] };
    await editor.putExternalContent(info);
    expect(previous.files).toHaveBeenCalledWith(info);
    expect(deps.uploadToVault).not.toHaveBeenCalled();
  });

  it("turns a pasted URL into a link note without any network request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { editor } = createFakeEditor();
    const { deps } = createDeps();
    registerPpmCanvasExternalContent(editor, () => deps);
    await editor.putExternalContent({ type: "url", url: "https://example.org/report", point: { x: 1, y: 2 } });
    expect(deps.createLinkNote).toHaveBeenCalledWith("https://example.org/report", { x: 1, y: 2 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ignores a dropped URL that is not http(s), with no note and no network request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { editor } = createFakeEditor();
    const { deps, notices } = createDeps();
    registerPpmCanvasExternalContent(editor, () => deps);
    await editor.putExternalContent({ type: "url", url: "javascript:alert(1)", point: { x: 1, y: 2 } });
    expect(deps.createLinkNote).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it("does nothing but explain for readers across files, url and svg-text, and restores the handlers on dispose", async () => {
    const { editor, handlers, previous } = createFakeEditor();
    const { deps, notices } = createDeps({ canEdit: false });
    const dispose = registerPpmCanvasExternalContent(editor, () => deps);
    await editor.putExternalContent({ type: "files", files: [png()] });
    await editor.putExternalContent({ type: "url", url: "https://example.org" });
    await editor.putExternalContent({ type: "svg-text", text: "<svg></svg>" });
    expect(deps.uploadToVault).not.toHaveBeenCalled();
    expect(deps.createLinkNote).not.toHaveBeenCalled();
    // Раунд 1: под v2 читателю ничего не делегируется — ни в files (уже проверено ниже через dispose), ни в url/svg.
    expect(previous.files).not.toHaveBeenCalled();
    expect(previous.url).not.toHaveBeenCalled();
    expect(previous["svg-text"]).not.toHaveBeenCalled();
    const placeholder = getPpmTranslation("ru", "canvas.file_drop_placeholder");
    expect(notices).toEqual([placeholder, placeholder, placeholder]);
    dispose();
    expect(handlers.files).toBe(previous.files);
    expect(handlers.url).toBe(previous.url);
    expect(handlers["svg-text"]).toBe(previous["svg-text"]);
  });

  // Мультидоска (живая проверка AF2.1): у каждой открытой вкладки свой редактор, и одна ⌘V попадала во все. Защита
  // второго уровня (первый — фокус только у активной вкладки, multi-board-focus.test.ts): скрытая вкладка не делает ничего.
  it.each([{ grammarV2: true }, { grammarV2: false }])(
    "does nothing at all on a hidden board tab: no upload, no card, no delegation, no notice (grammarV2=$grammarV2)",
    async ({ grammarV2 }) => {
      const { editor, previous } = createFakeEditor();
      const { deps, notices } = createDeps({ grammarV2, isActive: false });
      registerPpmCanvasExternalContent(editor, () => deps);
      await editor.putExternalContent({ type: "files", files: [png()], point: { x: 10, y: 20 } });
      await editor.putExternalContent({ type: "url", url: "https://example.org/report", point: { x: 1, y: 2 } });
      await editor.putExternalContent({ type: "svg-text", text: "<svg></svg>" });
      expect(deps.uploadToVault).not.toHaveBeenCalled();
      expect(deps.placeVaultEntry).not.toHaveBeenCalled();
      expect(deps.createLinkNote).not.toHaveBeenCalled();
      expect(previous.files).not.toHaveBeenCalled();
      expect(previous.url).not.toHaveBeenCalled();
      expect(previous["svg-text"]).not.toHaveBeenCalled();
      expect(notices).toEqual([]);
    }
  );

  it("reads the tab state at paste time: the same board accepts files once its tab is active again", async () => {
    const { editor } = createFakeEditor();
    const { deps } = createDeps();
    let isActive = false;
    registerPpmCanvasExternalContent(editor, () => ({ ...deps, isActive }));
    await editor.putExternalContent({ type: "files", files: [png()] });
    expect(deps.uploadToVault).not.toHaveBeenCalled();
    isActive = true;
    await editor.putExternalContent({ type: "files", files: [png()] });
    expect(deps.uploadToVault).toHaveBeenCalledTimes(1);
    expect(deps.placeVaultEntry).toHaveBeenCalledTimes(1);
  });

  it("picks the Russian plural for the drop hint and wires the handlers in onMount", () => {
    expect([1, 3, 5, 21].map((count) => dropHintKey(count, "ru"))).toEqual([
      "canvas.drop_hint_one",
      "canvas.drop_hint_few",
      "canvas.drop_hint_many",
      "canvas.drop_hint_one",
    ]);
    expect(dropHintKey(21, "en")).toBe("canvas.drop_hint_many");
    expect(editorSource).toContain("registerPpmCanvasExternalContent(mounted, getExternalContentDeps)");
    expect(editorSource).toMatch(/if \(grammarV2Ref\.current\) \{\s*void dropFilesV2Ref\.current\(files, pagePoint\);/);
    // Раунд 1: подсказка K4 считает только файловые записи dataTransfer, и ⌘U не предлагает видео.
    expect(editorSource).toContain('item.kind === "file"');
    expect(editorSource).toContain("acceptedVideoMimeTypes={grammarV2 ? [] : undefined}");
  });
});

// Финальная волна (M-3): файлы, брошенные на живую карточку задачи (v2, RB10), — по шаблону B4: размер до загрузки,
// ошибки с именами, счётчики, без сырого error.message; повтор не прикрепляет те же файлы второй раз.
const file = (name: string, size = 4, lastModified = 1_000) => new File([new Uint8Array(size)], name, { lastModified });

describe("files dropped on a task card (final wave, M-3)", () => {
  function attachDeps(overrides: Partial<TPpmWorkItemAttachDeps> = {}) {
    const notices: string[] = [];
    const placed = new Set<string>();
    const deps: TPpmWorkItemAttachDeps = {
      isPlaced: (assetId) => placed.has(assetId),
      maxUploadBytes: 1024,
      memory: new Map(),
      notify: (message) => notices.push(message),
      place: vi.fn(async (assetId: string) => {
        placed.add(assetId);
      }),
      t: (key) => getPpmTranslation("ru", key),
      upload: vi.fn(async (dropped: File) => ({ asset_id: `asset:${dropped.name}` })),
      workItemId: "wi-1",
      workItemName: "ROBOT-7",
      ...overrides,
    };
    return { deps, notices, placed };
  }

  it("attaches each file and places its card, counting what was attached", async () => {
    const { deps, notices } = attachDeps();
    const outcome = await attachFilesToWorkItem(deps, [file("Схема.png"), file("Отчёт.pdf")]);
    expect(outcome).toEqual({ already: 0, attached: 2, failed: [], notPlaced: 0, tooLarge: [] });
    expect(vi.mocked(deps.place).mock.calls).toEqual([
      ["asset:Схема.png", 0],
      ["asset:Отчёт.pdf", 1],
    ]);
    expect(notices).toEqual(["Прикреплено к ROBOT-7: 2."]);
  });

  it("refuses a file over the attachment limit before uploading, and names failed files without raw errors", async () => {
    const upload = vi.fn(async (dropped: File) => {
      if (dropped.name === "Сбой.pdf") throw new Error("AxiosError: Request failed with status code 500");
      return { asset_id: `asset:${dropped.name}` };
    });
    const { deps, notices } = attachDeps({ maxUploadBytes: 2 * 1024 * 1024, upload });
    const outcome = await attachFilesToWorkItem(deps, [
      file("Большой.zip", 3 * 1024 * 1024),
      file("Сбой.pdf"),
      file("Схема.png"),
    ]);
    expect(upload.mock.calls.map(([dropped]) => dropped.name)).toEqual(["Сбой.pdf", "Схема.png"]);
    expect(outcome).toEqual({ already: 0, attached: 1, failed: ["Сбой.pdf"], notPlaced: 0, tooLarge: ["Большой.zip"] });
    const notice = notices.join(" ");
    expect(notice).toBe(
      "Прикреплено к ROBOT-7: 1. Не удалось прикрепить: 1 — «Сбой.pdf». " +
        "Файл «Большой.zip» больше 2 МБ — к задаче можно прикрепить файлы до 2 МБ."
    );
    expect(notice).not.toContain("AxiosError");
  });

  it("never attaches the same file twice in a session: re-drop only places a missing card", async () => {
    let placeFails = true;
    const { deps, notices, placed } = attachDeps({
      place: vi.fn(async (assetId: string) => {
        if (placeFails && assetId === "asset:Карта.png") throw new Error("boom");
        placed.add(assetId);
      }),
    });
    const drop = () => [file("Схема.png"), file("Карта.png")];
    expect(await attachFilesToWorkItem(deps, drop())).toEqual({
      already: 0,
      attached: 1,
      failed: [],
      notPlaced: 1,
      tooLarge: [],
    });
    expect(notices.at(-1)).toBe(
      "Прикреплено к ROBOT-7: 1. " +
        "Прикреплены к ROBOT-7, но не добавлены на холст: 1 — отпустите их на задачу ещё раз, чтобы добавить."
    );
    // Повтор: «Схема» уже прикреплена и на холсте — не грузим; «Карта» прикреплена, но без карточки — только кладём.
    placeFails = false;
    expect(await attachFilesToWorkItem(deps, drop())).toEqual({
      already: 1,
      attached: 1,
      failed: [],
      notPlaced: 0,
      tooLarge: [],
    });
    expect(vi.mocked(deps.upload)).toHaveBeenCalledTimes(2);
    expect(notices.at(-1)).toBe("Прикреплено к ROBOT-7: 1. Уже прикреплены к ROBOT-7: 1 — повторно не загружаем.");
    // Карточку убрали с холста — повтор снова кладёт её, но файл второй раз не загружает.
    placed.delete("asset:Схема.png");
    await attachFilesToWorkItem(deps, [file("Схема.png")]);
    expect(vi.mocked(deps.upload)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deps.place).mock.calls.at(-1)).toEqual(["asset:Схема.png", 0]);
    // Тот же файл на другую задачу — это другое вложение.
    await attachFilesToWorkItem({ ...deps, workItemId: "wi-2", workItemName: "ROBOT-8" }, [file("Схема.png")]);
    expect(vi.mocked(deps.upload)).toHaveBeenCalledTimes(3);
  });

  it("does not start a second upload of a file whose first upload is still running", async () => {
    let release: ((value: { asset_id: string }) => void) | undefined;
    const upload = vi.fn(
      () =>
        new Promise<{ asset_id: string }>((resolve) => {
          release = resolve;
        })
    );
    const { deps } = attachDeps({ upload });
    const first = attachFilesToWorkItem(deps, [file("Схема.png")]);
    const second = await attachFilesToWorkItem(deps, [file("Схема.png")]);
    expect(second).toEqual({ already: 1, attached: 0, failed: [], notPlaced: 0, tooLarge: [] });
    release?.({ asset_id: "asset:1" });
    await expect(first).resolves.toMatchObject({ attached: 1 });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("fingerprints a dropped file by task, name, size and modification time", () => {
    expect(attachmentFingerprint("wi-1", file("a.png", 4, 1))).not.toBe(
      attachmentFingerprint("wi-2", file("a.png", 4, 1))
    );
    expect(attachmentFingerprint("wi-1", file("a.png", 4, 1))).not.toBe(
      attachmentFingerprint("wi-1", file("a.png", 5, 1))
    );
    expect(attachmentFingerprint("wi-1", file("a.png", 4, 1))).not.toBe(
      attachmentFingerprint("wi-1", file("a.png", 4, 2))
    );
    expect(attachmentFingerprint("wi-1", file("a.png", 4, 1))).toBe(attachmentFingerprint("wi-1", file("a.png", 4, 1)));
  });

  it("wires the task-card drop through the B4 pattern with the attachment limit of the instance", () => {
    const dropBlock = editorSource.slice(
      editorSource.indexOf("const dropFilesV2 = useCallback("),
      editorSource.indexOf("const dropFilesV2Ref = useRef(dropFilesV2);")
    );
    expect(dropBlock).toContain("await attachFilesToWorkItem(");
    expect(dropBlock).toContain("maxUploadBytes: instanceMaxFileSize,");
    expect(dropBlock).toContain("memory: attachMemoryRef.current,");
    expect(dropBlock).toContain(
      'isPlaced: (assetId) => Boolean(boundCardId(activeEditor.getCurrentPageShapes(), "attachment", assetId)),'
    );
    expect(dropBlock).not.toContain("error.message");
    for (const key of [
      "canvas.drop_attach_already",
      "canvas.drop_attach_not_placed",
      "canvas.drop_attach_too_large",
      "canvas.drop_attach_failed",
    ] as const) {
      expect(getPpmTranslation("ru", key), key).toMatch(/[а-яё]/i);
      expect(getPpmTranslation("en", key), key).not.toMatch(/[а-яё]/i);
    }
  });
});
