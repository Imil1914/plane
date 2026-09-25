import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { getPpmTranslation } from "@ppm/brand";
import type { TPpmCanvasContentBinding } from "@ppm/canvas";
import {
  capPreviewText,
  filePreviewKind,
  filePreviewUnsupportedKey,
  isRetryablePreviewError,
  isVaultGoneError,
  parseCsvPreview,
  PPM_TEXT_PREVIEW_MAX_BYTES,
  vaultPdfUrlFromPreview,
} from "@/components/ppm-canvas/canvas-file-kind";
import {
  isShrunkWorkItemsView,
  isWorkItemDrag,
  PPM_WORK_ITEM_DRAG_TYPE,
} from "@/components/ppm-canvas/canvas-placement";
import {
  downloadCanvasFile,
  filePreviewDownloadNotice,
  filePreviewMediaUrl,
  isFromCanvasModal,
  loadFilePreview,
  loadVaultFileBlob,
  markdownPreviewPlainKey,
  nextSheetIndex,
  syncCanvasEditorFocus,
  vaultPdfUrl,
  type TFilePreviewVault,
} from "@/components/ppm-canvas/file-preview";
import { normalizeVaultRawError } from "@/services/ppm-vault.service";

const read = (path: string) => readFileSync(new URL(`../../core/${path}`, import.meta.url), "utf8");
const shapeSource = read("components/ppm-canvas/shape.tsx");
const previewSource = read("components/ppm-canvas/file-preview.tsx");
const vaultServiceSource = read("services/ppm-vault.service.ts");
const editorSource = read("components/ppm-canvas/editor.tsx");

describe("file cards: preview and download (AF2.1 B5)", () => {
  it("chooses the preview by extension and MIME type", () => {
    expect(filePreviewKind(".png", "image/png")).toBe("image");
    expect(filePreviewKind(".pdf", "application/pdf")).toBe("pdf");
    expect(filePreviewKind(".md", "text/markdown")).toBe("markdown");
    expect(filePreviewKind(".csv", "text/csv")).toBe("csv");
    expect(filePreviewKind(".json", "application/json")).toBe("json");
    expect(filePreviewKind(".py", "text/x-python")).toBe("code");
    expect(filePreviewKind(".txt", "text/plain")).toBe("text");
    expect(
      ["docx", "xlsx", "pptx"].map((extension) => filePreviewKind(`.${extension}`, "application/octet-stream"))
    ).toEqual(["office", "office", "office"]);
    expect(filePreviewKind(".key", "application/octet-stream")).toBe("download");
    expect(filePreviewKind(".svg", "image/svg+xml")).toBe("code");
  });

  it("parses CSV with quotes, detects the delimiter and caps the size", () => {
    expect(parseCsvPreview('a,b\n"1,5",2\n')).toEqual({
      rows: [
        ["a", "b"],
        ["1,5", "2"],
      ],
      truncated: false,
    });
    expect(parseCsvPreview("a;b\r\n1;2")).toEqual({
      rows: [
        ["a", "b"],
        ["1", "2"],
      ],
      truncated: false,
    });
    expect(parseCsvPreview('"say ""hi""",x')).toEqual({ rows: [['say "hi"', "x"]], truncated: false });
    const big = parseCsvPreview("x\n".repeat(300));
    expect(big.rows).toHaveLength(200);
    expect(big.truncated).toBe(true);
    expect(parseCsvPreview(Array.from({ length: 60 }, (_, index) => `c${index}`).join(",")).rows[0]).toHaveLength(50);
  });

  it("previews Vault PDFs through /pdf/ without a sandbox, attachments stay sandboxed", () => {
    expect(
      vaultPdfUrlFromPreview("http://localhost:8000/api/ppm/v1/workspaces/w/projects/p/vault/entries/e/file/")
    ).toBe("http://localhost:8000/api/ppm/v1/workspaces/w/projects/p/vault/entries/e/pdf/");
    expect(shapeSource).toContain('sandbox={vaultPdf ? undefined : ""}');
    expect(previewSource).toContain("createPortal(");
    // Раунд 1: HTML сервера — строгий режим санитизации (без style, SVG, MathML).
    expect(previewSource).toContain("sanitizeCanvasHtml(preview.html, { allowKatex: false })");
    // Раунд 1: во фрейм просмотра попадает только PDF Хранилища (/pdf/) — ветка «вложение в песочнице» была мёртвой;
    // PDF вложения во фрейм не попадает вовсе (filePreviewMediaUrl → null, тест ниже).
    expect(previewSource).not.toContain("sandbox=");
    expect(previewSource).toContain('<iframe referrerPolicy="no-referrer" src={mediaUrl} title={display.title} />');
    expect(vaultServiceSource).toContain("entries/${entryId}/preview/");
  });

  it("restores the working task board under v2 without silent writes", () => {
    expect(shapeSource).not.toContain("ppm-work-items-view--compact");
    expect(shapeSource).not.toMatch(/props: \{ w: 360, h: 160 \}/);
    expect(shapeSource).toContain("data-ppm-drag-handle");
    expect(shapeSource).toMatch(/grammarV2 && \(\s*<button[^>]*className="ppm-work-items-view__backlog"/);
  });

  it("names preview and download in both languages", () => {
    expect(getPpmTranslation("ru", "canvas.file_preview")).toBe("Просмотр");
    expect(getPpmTranslation("ru", "canvas.file_download")).toBe("Скачать");
    expect(getPpmTranslation("en", "canvas.file_download")).toBe("Download");
  });
});

// ── Сверх брифа: требования контроллера (S готов, отмена запросов, фокус, Esc, без записи в доску) ──

const IDS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"] as const;
const ENTRY = "33333333-3333-4333-8333-333333333333";
const boardSource = shapeSource.slice(
  shapeSource.indexOf("function WorkItemsViewNode("),
  shapeSource.indexOf("function WorkItemsList(")
);

function fileBinding(
  extension: string | null,
  mime: string,
  entityType: "attachment" | "vault_file" = "vault_file"
): TPpmCanvasContentBinding {
  return {
    binding_id: "44444444-4444-4444-8444-444444444444",
    binding_status: "active",
    entity_id: ENTRY,
    entity_type: entityType,
    shape_id: "shape:file",
    source_version: "2",
    source: {
      capabilities: { delete_source: false, read: true, update: true },
      display: {
        excerpt: null,
        extension,
        mime_type: mime,
        preview_url: entityType === "vault_file" ? "http://api.test/vault/entries/e/file/" : "http://api.test/assets/a",
        size_bytes: 128,
        source_status: "active",
        title: `Замеры${extension ?? ""}`,
      },
      identity: {
        entity_id: ENTRY,
        entity_type: entityType,
        project_id: IDS[1],
        source_url: "/ws/projects/p/knowledge?entry_id=e",
        workspace_id: IDS[0],
      },
      source_version: "2",
    },
  };
}

const httpError = (status: number | undefined, code?: string) =>
  Object.assign(new Error(`HTTP ${status ?? "network"}`), { code, status });

// По умолчанию: маршрута превью нет (старый сервер — 404 без кода, RB8), у записи нет /content/ и /file/.
function fakeVault(overrides: Partial<TFilePreviewVault> = {}) {
  const vault = {
    fileUrl: vi.fn(
      (workspaceId: string, projectId: string, entryId: string) =>
        `https://api.test/${workspaceId}/${projectId}/${entryId}/file/`
    ),
    getFileBlob: vi.fn(async () => new Blob(["bytes"])),
    getFileText: vi.fn(async (): Promise<string> => {
      throw httpError(404, "VAULT_ENTRY_NOT_FOUND");
    }),
    getMarkdown: vi.fn(async (): Promise<{ content: string }> => {
      throw httpError(404, "VAULT_ENTRY_NOT_FOUND");
    }),
    getPreview: vi.fn(async (): Promise<never> => {
      throw httpError(404);
    }),
    pdfUrl: vi.fn(
      (workspaceId: string, projectId: string, entryId: string) =>
        `https://api.test/${workspaceId}/${projectId}/${entryId}/pdf/`
    ),
    ...overrides,
  };
  return vault as typeof vault & TFilePreviewVault;
}

describe("file preview loading (AF2.1 B5, server previews S1–S3)", () => {
  it("covers GIF and the code/text files the Vault accepts", () => {
    expect(filePreviewKind(".gif", "image/gif")).toBe("image");
    expect(
      ["ts", "sql", "yaml", "sh", "go"].map((extension) => filePreviewKind(`.${extension}`, "text/plain"))
    ).toEqual(["code", "code", "code", "code", "code"]);
    expect(filePreviewKind(".log", "text/plain")).toBe("text");
    expect(filePreviewKind(".tsv", "text/plain")).toBe("csv");
    expect(filePreviewKind(".doc", "application/msword")).toBe("download");
    expect(filePreviewKind(null, "text/markdown")).toBe("markdown");
  });

  it("shows Office previews built by the server and explains limits, passwords and busy storage", async () => {
    const signal = new AbortController().signal;
    const docx = { html: "<p>Протокол</p>", kind: "docx" as const, truncated: false };
    const vault = fakeVault({ getPreview: vi.fn(async () => docx) });
    await expect(loadFilePreview(fileBinding(".docx", "application/octet-stream"), vault, signal)).resolves.toEqual({
      preview: docx,
      status: "ready",
    });
    expect(vault.getPreview).toHaveBeenCalledWith(IDS[0], IDS[1], ENTRY, { signal });

    const limits = fakeVault({
      getPreview: vi.fn(async () => ({ kind: "unsupported" as const, reason: "limits", truncated: false })),
    });
    await expect(loadFilePreview(fileBinding(".xlsx", "application/octet-stream"), limits, signal)).resolves.toEqual({
      reason: "limits",
      status: "unsupported",
    });
    expect(filePreviewUnsupportedKey("limits")).toBe("canvas.file_preview_too_large");
    expect(filePreviewUnsupportedKey("too_large")).toBe("canvas.file_preview_too_large");
    expect(filePreviewUnsupportedKey("encrypted")).toBe("canvas.file_preview_encrypted");
    expect(filePreviewUnsupportedKey("type")).toBe("canvas.file_preview_unsupported");
    expect(filePreviewUnsupportedKey(undefined)).toBe("canvas.file_preview_unsupported");
    // Раунд 1: «limits» бывает и от бюджета времени сервера — рядом со «Скачать» есть «Повторить».
    expect(previewSource).toContain('{state.reason === "limits" && retryButton}');

    // 503 VAULT_STORAGE_FAILED (занято/хранилище) и обрыв сети — «Повторить»; Office без сервера не читаем.
    const busy = await Promise.all(
      [httpError(503, "VAULT_STORAGE_FAILED"), httpError(undefined)].map((failure) =>
        loadFilePreview(
          fileBinding(".pptx", "application/octet-stream"),
          fakeVault({ getPreview: vi.fn(async () => Promise.reject(failure)) }),
          signal
        )
      )
    );
    expect(busy).toEqual([{ status: "retry" }, { status: "retry" }]);
    expect([isRetryablePreviewError(httpError(503)), isRetryablePreviewError(httpError(404))]).toEqual([true, false]);
    const missing = fakeVault();
    await expect(loadFilePreview(fileBinding(".docx", "application/octet-stream"), missing, signal)).resolves.toEqual({
      status: "unsupported",
    });
    expect(missing.getFileText).not.toHaveBeenCalled();
  });

  it("says «no access or deleted» for 403 and 404 VAULT_ENTRY_NOT_FOUND, not «no preview»", async () => {
    const signal = new AbortController().signal;
    const failures = [httpError(404, "VAULT_ENTRY_NOT_FOUND"), httpError(403, "VAULT_PERMISSION_DENIED")];
    const vaults = failures.map((failure) => fakeVault({ getPreview: vi.fn(async () => Promise.reject(failure)) }));
    const states = await Promise.all(
      vaults.flatMap((vault) => [
        loadFilePreview(fileBinding(".docx", "application/octet-stream"), vault, signal),
        loadFilePreview(fileBinding(".txt", "text/plain"), vault, signal),
      ])
    );
    expect(states).toEqual([{ status: "gone" }, { status: "gone" }, { status: "gone" }, { status: "gone" }]);
    for (const vault of vaults) expect(vault.getFileText).not.toHaveBeenCalled();
    // 404 без кода — нет самого маршрута (старый сервер): запасной путь RB8, а не «удалён».
    expect([isVaultGoneError(httpError(404)), isVaultGoneError(httpError(403))]).toEqual([false, true]);
    expect(getPpmTranslation("ru", "canvas.file_preview_gone")).toBe("Нет доступа или файл удалён.");
  });

  it("reads text through the server preview, then Markdown content, then the file itself (RB8)", async () => {
    const signal = new AbortController().signal;
    const csv = fakeVault({
      getPreview: vi.fn(async () => ({ kind: "text" as const, text: "a,b\n1,2", truncated: true })),
    });
    await expect(loadFilePreview(fileBinding(".csv", "text/csv"), csv, signal)).resolves.toEqual({
      status: "text",
      text: "a,b\n1,2",
      truncated: true,
    });
    expect(csv.getFileText).not.toHaveBeenCalled();

    const material = fakeVault({ getMarkdown: vi.fn(async () => ({ content: "# Протокол" })) });
    await expect(loadFilePreview(fileBinding(".md", "text/markdown"), material, signal)).resolves.toEqual({
      status: "text",
      text: "# Протокол",
      truncated: false,
    });
    // Вставленный .md — обычный файл Хранилища (kind file): /content/ отвечает 404, текст — из /file/.
    const pasted = fakeVault({ getFileText: vi.fn(async () => "x".repeat(PPM_TEXT_PREVIEW_MAX_BYTES + 5)) });
    const state = await loadFilePreview(fileBinding(".md", "text/markdown"), pasted, signal);
    expect(state).toMatchObject({ status: "text", truncated: true });
    expect(state.status === "text" && state.text.length).toBe(PPM_TEXT_PREVIEW_MAX_BYTES);
    expect(pasted.getFileText).toHaveBeenCalledWith(IDS[0], IDS[1], ENTRY, { signal });

    const busyFile = fakeVault({
      getFileText: vi.fn(async () => Promise.reject(httpError(503, "VAULT_STORAGE_FAILED"))),
    });
    await expect(loadFilePreview(fileBinding(".json", "application/json"), busyFile, signal)).resolves.toEqual({
      status: "retry",
    });
    const broken = fakeVault({ getFileText: vi.fn(async () => Promise.reject(httpError(500))) });
    await expect(loadFilePreview(fileBinding(".txt", "text/plain"), broken, signal)).resolves.toEqual({
      status: "error",
    });
    await expect(loadFilePreview(fileBinding(".txt", "text/plain"), fakeVault(), signal)).resolves.toEqual({
      status: "gone",
    });
  });

  it("caps text in UTF-8 bytes on a character boundary, the /content/ path included", async () => {
    expect(capPreviewText("abc", 10)).toEqual({ text: "abc", truncated: false });
    expect(capPreviewText("яяя", 4)).toEqual({ text: "яя", truncated: true });
    expect(capPreviewText("aяb", 2)).toEqual({ text: "a", truncated: true });
    expect(capPreviewText("😀x", 3)).toEqual({ text: "", truncated: true });
    const cyrillic = capPreviewText("я".repeat(600_000));
    expect(cyrillic.truncated).toBe(true);
    expect(cyrillic.text).toHaveLength(PPM_TEXT_PREVIEW_MAX_BYTES / 2);
    expect(new TextEncoder().encode(cyrillic.text).length).toBeLessThanOrEqual(PPM_TEXT_PREVIEW_MAX_BYTES);

    const material = fakeVault({ getMarkdown: vi.fn(async () => ({ content: "я".repeat(600_000) })) });
    const state = await loadFilePreview(fileBinding(".md", "text/markdown"), material, new AbortController().signal);
    expect(state).toMatchObject({ status: "text", truncated: true });
    expect(state.status === "text" && state.text.length).toBe(PPM_TEXT_PREVIEW_MAX_BYTES / 2);
  });

  it("stops at once when the dialog closes: the request is aborted and no fallback starts", async () => {
    const controller = new AbortController();
    const vault = fakeVault({
      getPreview: vi.fn(
        (_workspaceId: string, _projectId: string, _entryId: string, options?: { signal?: AbortSignal }) =>
          new Promise<never>((_resolve, reject) =>
            options?.signal?.addEventListener("abort", () => reject(httpError(undefined)))
          )
      ),
    });
    const pending = loadFilePreview(fileBinding(".py", "text/plain"), vault, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(vault.getMarkdown).not.toHaveBeenCalled();
    expect(vault.getFileText).not.toHaveBeenCalled();
  });

  it("loads images and Vault PDFs by URL only; attachment PDFs and unknown formats offer the download", async () => {
    const signal = new AbortController().signal;
    const vault = fakeVault();
    const image = fileBinding(".jpg", "image/jpeg");
    await expect(loadFilePreview(image, vault, signal)).resolves.toEqual({ status: "media" });
    expect(filePreviewMediaUrl(image, vault)).toBe(`https://api.test/${IDS[0]}/${IDS[1]}/${ENTRY}/file/`);
    expect(filePreviewMediaUrl(fileBinding(".pdf", "application/pdf"), vault)).toBe(
      `https://api.test/${IDS[0]}/${IDS[1]}/${ENTRY}/pdf/`
    );
    expect(filePreviewMediaUrl(fileBinding(".png", "image/png", "attachment"), vault)).toBe("http://api.test/assets/a");
    // Встроенный просмотрщик PDF в песочнице не работает, а вложения задач без песочницы не открываем (RB7).
    const attachmentPdf = fileBinding(".pdf", "application/pdf", "attachment");
    expect(filePreviewMediaUrl(attachmentPdf, vault)).toBeNull();
    await expect(loadFilePreview(attachmentPdf, vault, signal)).resolves.toEqual({ status: "unsupported" });
    await expect(loadFilePreview(fileBinding(".key", "application/octet-stream"), vault, signal)).resolves.toEqual({
      status: "unsupported",
    });
    expect(vault.getPreview).not.toHaveBeenCalled();
  });

  it("builds the card's PDF frame URL from the source identity, never from the raw preview_url", () => {
    const vault = fakeVault();
    expect(vaultPdfUrl(fileBinding(".pdf", "application/pdf"), vault)).toBe(
      `https://api.test/${IDS[0]}/${IDS[1]}/${ENTRY}/pdf/`
    );
    expect(vault.pdfUrl).toHaveBeenCalledWith(IDS[0], IDS[1], ENTRY);
    expect(vaultPdfUrl(fileBinding(".pdf", "application/pdf", "attachment"), vault)).toBeNull();
    expect(vaultPdfUrl(fileBinding(".png", "image/png"), vault)).toBeNull();
    expect(shapeSource).not.toContain("vaultPdfUrlFromPreview");
    expect(shapeSource).toMatch(
      /const vaultPdfSrc =\s+grammarV2 && binding\.entity_type === "vault_file" && node\.kind === "pdf"\s+\? contentActions\.vaultPdfUrl\(binding\)\s+: null;/
    );
    expect(shapeSource).toContain("src={vaultPdfSrc ? `${vaultPdfSrc}#toolbar=0&view=FitH` : previewUrl}");
    expect(editorSource).toContain("vaultPdfUrl: vaultPdfSrc,");
  });

  it("downloads a Vault Markdown material from its content: it has no binary file", async () => {
    const blob = new Blob(["%PDF-"]);
    await expect(
      loadVaultFileBlob(fileBinding(".pdf", "application/pdf"), fakeVault({ getFileBlob: vi.fn(async () => blob) }))
    ).resolves.toBe(blob);
    const material = fakeVault({
      getFileBlob: vi.fn(async () => Promise.reject(httpError(400, "VAULT_INVALID_FILE_TYPE"))),
      getMarkdown: vi.fn(async () => ({ content: "# План" })),
    });
    const saved = await loadVaultFileBlob(fileBinding(".md", "text/markdown"), material);
    expect(await saved.text()).toBe("# План");
    expect(saved.type).toBe("text/markdown;charset=utf-8");
    const gone = fakeVault({ getFileBlob: vi.fn(async () => Promise.reject(httpError(404, "VAULT_ENTRY_NOT_FOUND"))) });
    await expect(loadVaultFileBlob(fileBinding(".pdf", "application/pdf"), gone)).rejects.toMatchObject({
      status: 404,
    });
    expect(gone.getMarkdown).not.toHaveBeenCalled();
  });

  it("saves under the card name; no server answer → a link the user clicks; an error answer → notice", async () => {
    const opened: unknown[][] = [];
    const anchors: Array<{ click: ReturnType<typeof vi.fn>; download: string; href: string; rel: string }> = [];
    vi.stubGlobal("window", {
      document: {
        createElement: () => {
          const anchor = { click: vi.fn(), download: "", href: "", rel: "" };
          anchors.push(anchor);
          return anchor;
        },
      },
      open: (...args: unknown[]) => {
        opened.push(args);
        return null;
      },
      setTimeout: () => 0,
    });
    try {
      const vault = {
        ...fakeVault(),
        downloadUrl: (workspaceId: string, projectId: string, entryId: string) =>
          `https://api.test/${workspaceId}/${projectId}/${entryId}/file/?download=1`,
      };
      await expect(downloadCanvasFile(fileBinding(".xlsx", "application/octet-stream"), vault)).resolves.toEqual({
        status: "started",
      });
      expect(anchors).toHaveLength(1);
      expect(anchors[0]).toMatchObject({ download: "Замеры.xlsx", rel: "noopener" });
      expect(anchors[0].click).toHaveBeenCalledTimes(1);
      expect(anchors[0].href).toMatch(/^blob:/);

      // S3: 302 на подписанную ссылку без CORS — ответа нет. window.open после await заблокировал бы браузер:
      // вместо него — ссылка в уведомлении, её щёлкает сам пользователь.
      const cors = { ...vault, getFileBlob: vi.fn(async () => Promise.reject(httpError(undefined))) };
      await expect(downloadCanvasFile(fileBinding(".pdf", "application/pdf"), cors)).resolves.toEqual({
        status: "link",
        url: `https://api.test/${IDS[0]}/${IDS[1]}/${ENTRY}/file/?download=1`,
      });
      const busy = { ...vault, getFileBlob: vi.fn(async () => Promise.reject(httpError(503, "VAULT_STORAGE_FAILED"))) };
      await expect(downloadCanvasFile(fileBinding(".pdf", "application/pdf"), busy)).resolves.toEqual({
        status: "error",
      });
      expect(opened).toEqual([]);

      // Вложение задачи — его ссылка в новой вкладке, синхронно в том же щелчке (до первого await).
      await expect(downloadCanvasFile(fileBinding(".png", "image/png", "attachment"), vault)).resolves.toEqual({
        status: "started",
      });
      expect(opened).toEqual([["http://api.test/assets/a", "_blank", "noopener"]]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the Vault error code of blob and text responses", async () => {
    const body = JSON.stringify({
      error: { code: "VAULT_INVALID_FILE_TYPE", message: "У материала нет бинарного файла." },
    });
    const blobError = await normalizeVaultRawError({
      isAxiosError: true,
      message: "Request failed",
      response: { data: new Blob([body], { type: "application/json" }), status: 400 },
    });
    expect(blobError).toMatchObject({
      code: "VAULT_INVALID_FILE_TYPE",
      message: "У материала нет бинарного файла.",
      status: 400,
    });
    const textError = await normalizeVaultRawError({
      isAxiosError: true,
      message: "Request failed",
      response: { data: body.replace("VAULT_INVALID_FILE_TYPE", "VAULT_STORAGE_FAILED"), status: 503 },
    });
    expect(textError).toMatchObject({ code: "VAULT_STORAGE_FAILED", status: 503 });
  });
});

describe("file preview dialog contract (AF2.1 B5)", () => {
  const downloadBlock = editorSource.slice(
    editorSource.indexOf("// ── AF2.1 B: (B5) просмотр и скачивание файлов ──"),
    editorSource.indexOf(
      "// ── /AF2.1 B ──",
      editorSource.indexOf("// ── AF2.1 B: (B5) просмотр и скачивание файлов ──")
    )
  );

  it("switches tldraw hotkeys off while any canvas dialog is open — one effect for the picker and the preview", () => {
    const calls: string[] = [];
    const body: { ownerDocument?: { body: unknown } } = {};
    body.ownerDocument = { body };
    // Кнопка «Просмотр» на карточке — в холсте этого же редактора (правила «потерян» — multi-board-focus.test.ts).
    const container = {};
    const button = {
      closest: (selector: string) => (selector === ".tl-container" ? container : null),
      ownerDocument: { body },
    } as unknown as Element;
    const editor = {
      blur: () => {
        calls.push("blur");
        return editor;
      },
      focus: (options?: { focusContainer?: boolean }) => {
        calls.push(`focus:${String(options?.focusContainer)}`);
        return editor;
      },
      getContainer: () => container,
    } as unknown as Parameters<typeof syncCanvasEditorFocus>[0];
    syncCanvasEditorFocus(editor, { isActive: true, modalOpen: true }, button);
    // Диалог вернул фокус на место (кнопка «Просмотр») — не отнимаем; фокус потерян (body, null) — контейнер холста.
    syncCanvasEditorFocus(editor, { isActive: true, modalOpen: false }, button);
    syncCanvasEditorFocus(editor, { isActive: true, modalOpen: false }, body as unknown as Element);
    syncCanvasEditorFocus(editor, { isActive: true, modalOpen: false }, null);
    expect(calls).toEqual(["blur", "focus:false", "focus:true", "focus:true"]);
    // Финальная волна: выбор файла Хранилища («Из проекта → Файл») — третий диалог того же эффекта.
    expect(downloadBlock).toContain(
      "const canvasModalOpen = pagePickerOpen || vaultPickerOpen || previewBinding !== undefined;"
    );
    // Мультидоска: тот же единственный эффект выключает и редактор скрытой вкладки (multi-board-focus.test.ts).
    expect(downloadBlock).toContain(
      "if (editor) syncCanvasEditorFocus(editor, { isActive, modalOpen: canvasModalOpen });"
    );
    expect(editorSource.match(/syncCanvasEditorFocus\(/g)).toHaveLength(1);
    expect(editorSource).not.toMatch(/activeEditor\.blur\(\)|activeEditor\.focus\(\)/);
  });

  it("traps focus, closes on Escape by e.code and keeps keys away from tldraw", () => {
    expect(previewSource).toContain('event.code === "Escape"');
    expect(previewSource).toContain('event.code === "Tab"');
    expect(previewSource).not.toMatch(/event\.key\b/);
    expect(previewSource).toContain("event.stopPropagation();");
    expect(previewSource).toContain("data-ppm-focus-guard");
    expect(previewSource).toMatch(/aria-modal="true"[\s\S]{0,400}data-ppm-canvas-modal=""/);
  });

  it("navigates sheet tabs with the arrow keys and names the status only, not the buttons", () => {
    expect([
      nextSheetIndex("ArrowRight", 0, 3),
      nextSheetIndex("ArrowRight", 2, 3),
      nextSheetIndex("ArrowLeft", 0, 3),
      nextSheetIndex("Home", 2, 3),
      nextSheetIndex("End", 0, 3),
      nextSheetIndex("KeyA", 1, 3),
    ]).toEqual([1, 0, 2, 0, 2, undefined]);
    expect(previewSource).toContain("aria-controls={`${tabsId}-panel`}");
    expect(previewSource).toContain("tabIndex={index === current ? 0 : -1}");
    expect(previewSource).toContain("onKeyDown={(event) => onTabKeyDown(event, index)}");
    expect(previewSource).toMatch(
      /aria-labelledby=\{`\$\{tabsId\}-tab-\$\{current\}`\} id=\{`\$\{tabsId\}-panel`\} role="tabpanel"/
    );
    expect(previewSource).toContain('<p role="status">{text}</p>');
    expect(previewSource).not.toContain('<div className="ppm-file-preview__message" role="status">');
  });

  it("loads only when opened, aborts on close and never writes the board", () => {
    expect(previewSource).toContain("new AbortController()");
    expect(previewSource).toContain("controller.abort()");
    expect(previewSource).not.toMatch(/updateShape|createShape|useEditor|putExternalContent|\.store\./);
    for (const method of ["getPreview", "getFileText", "getFileBlob", "getMarkdown"])
      expect(vaultServiceSource).toMatch(
        new RegExp(`async ${method}\\([^)]*options: TPpmVaultRequestOptions = \\{\\}\\s*\\)`)
      );
    expect(vaultServiceSource.match(/signal: options\.signal/g)).toHaveLength(4);
    expect(editorSource).toMatch(/\{grammarV2 && previewBinding && \(\s*<PpmFilePreviewDialog/);
  });

  it("downloads without leaving the canvas and never drops files onto the canvas through a dialog", () => {
    expect(downloadBlock.length).toBeGreaterThan(0);
    // Финальная волна: скачивание возвращает исход; карточка показывает его уведомлением холста, диалог — у себя.
    expect(downloadBlock).toContain("return await downloadCanvasFile(binding, vaultService);");
    expect(downloadBlock).toContain("const result = await startDownload(binding);");
    expect(downloadBlock).toContain('setContentNotice(ppmT("canvas.file_download_error"))');
    expect(downloadBlock).toMatch(/result\.status === "link"\)\s+setContentNotice\(\{\s+href: result\.url,/);
    expect(editorSource).toContain('className="ppm-canvas-content-notice__link"');
    expect(downloadBlock).not.toContain("window.open");
    expect(previewSource.match(/window\.open\(/g)).toHaveLength(1);
    for (const source of [downloadBlock, previewSource])
      expect(source).not.toMatch(/window\.location|location\.(?:href|assign|replace)|\.navigate\(/);
    expect(vaultServiceSource).toContain("?download=1");

    const inShell = { closest: () => null } as unknown as EventTarget;
    const inShellModal = { closest: (selector: string) => (selector === "[data-ppm-canvas-modal]" ? {} : null) };
    const portal = { closest: () => null } as unknown as EventTarget;
    const shell = { contains: (node: unknown) => node === inShell || node === inShellModal };
    expect(isFromCanvasModal(shell, inShell)).toBe(false);
    expect(isFromCanvasModal(shell, portal)).toBe(true);
    expect(isFromCanvasModal(shell, inShellModal as unknown as EventTarget)).toBe(true);
    expect(isFromCanvasModal(shell, null)).toBe(false);
    expect(editorSource).toMatch(
      /if \(isFromCanvasModal\(event\.currentTarget, event\.target\)\) \{\s+event\.dataTransfer\.dropEffect = "none";\s+return;/
    );
    expect(previewSource).toMatch(/onDragOver=\{blockDrop\}\s+onDrop=\{blockDrop\}/);
  });

  it("keeps v1 cards as in UX1.1: buttons, the unsandboxed PDF and the board handle only under grammar v2", () => {
    expect(shapeSource).toMatch(/\{grammarV2 && !unavailable && \(/);
    expect(shapeSource).toMatch(
      /grammarV2 &&\s+binding\.entity_type !== "page" &&\s+display\.source_status !== "deleted" &&\s+display\.source_status !== "quarantined" && \(/
    );
    expect(shapeSource).toContain("data-ppm-drag-handle={grammarV2 || undefined}");
    expect(shapeSource).toMatch(
      /if \(grammarV2 && \(event\.target as HTMLElement\)\.closest\("\[data-ppm-drag-handle\]"\)\) return;/
    );
  });

  it("keeps «Развернуть доску» visible on a shrunk board: the first element of the header", () => {
    expect(isShrunkWorkItemsView({ h: 160, w: 360 })).toBe(true);
    expect(isShrunkWorkItemsView({ h: 220, w: 420 })).toBe(true);
    expect(isShrunkWorkItemsView({ h: 680, w: 1100 })).toBe(false);
    expect(isShrunkWorkItemsView({ h: 680, w: 360 })).toBe(false);
    expect(boardSource).toMatch(
      /<header className="ppm-work-items-view__header">\s+\{grammarV2 && !readonly && isShrunkWorkItemsView\(shape\.props\) && \(/
    );
    expect(boardSource.match(/canvas\.work_items_view_expand/g)).toHaveLength(1);
  });

  it("moves cards between columns in both looks: capture phase, only the card drag type (tldraw eats bubbling drops)", () => {
    expect(isWorkItemDrag(["text/plain", PPM_WORK_ITEM_DRAG_TYPE])).toBe(true);
    expect(isWorkItemDrag(["Files"])).toBe(false);
    expect(isWorkItemDrag(["text/plain"])).toBe(false);
    expect(boardSource).toContain("onDragOverCapture={(event) => {");
    expect(boardSource).toContain("onDropCapture={(event) => {");
    expect(boardSource).not.toMatch(/\bonDragOver=\{|\bonDrop=\{/);
    expect(boardSource.match(/if \(!isWorkItemDrag\(event\.dataTransfer\.types\)\) return;/g)).toHaveLength(2);
    expect(boardSource).toContain("event.dataTransfer.setData(PPM_WORK_ITEM_DRAG_TYPE, item.identity.entity_id);");
    expect(boardSource).toContain("void patchSource(source, { state_id: group.stateId }, optimistic);");
    expect(boardSource).toContain("await projectionContext.onUpdateSource(source, patch);");
  });

  it("names every new state in both languages", () => {
    for (const key of [
      "canvas.file_preview_busy",
      "canvas.file_preview_too_large",
      "canvas.file_preview_encrypted",
      "canvas.file_preview_values_only",
      "canvas.file_preview_gone",
      "canvas.file_download_link",
      "canvas.work_items_view_expand",
    ] as const) {
      expect(getPpmTranslation("ru", key), key).toMatch(/[а-яё]/i);
      expect(getPpmTranslation("en", key), key).toMatch(/^[\x20-\x7e—…«»]+$/);
    }
  });
});

// Финальная волна: M-1 (Markdown-файл без форматирования — с подписью о причине) и отложенное B5 (исход «Скачать»
// внутри просмотра показывается в самом диалоге, а не в уведомлении холста под модальным окном).
describe("file preview — final wave (M-1, B5)", () => {
  it("explains why a Vault Markdown file is shown without formatting, as the note card does", () => {
    expect(markdownPreviewPlainKey("# Отчёт\n\nкороткий файл")).toBeUndefined();
    expect(markdownPreviewPlainKey(`# README\n\n${"строка\n".repeat(2_000)}`)).toBe("canvas.file_preview_plain_long");
    // Под лимитом длины, но разметка, которую marked разбирал бы секундами (незакрытые ссылки).
    expect(markdownPreviewPlainKey("[a](".repeat(2_400))).toBe("canvas.file_preview_plain_complex");
    const previewText = previewSource.slice(
      previewSource.indexOf("function PreviewText("),
      previewSource.indexOf("function OfficePreview(")
    );
    expect(previewText).toContain("plainKey: markdownPreviewPlainKey(text),");
    expect(previewText).toMatch(
      /\{content\.plainKey && <small className="ppm-file-preview__note">\{ppmT\(content\.plainKey\)\}<\/small>\}/
    );
    expect(getPpmTranslation("ru", "canvas.file_preview_plain_long")).toBe(
      "Файл большой — показан без форматирования (больше 10 000 знаков)"
    );
    expect(getPpmTranslation("ru", "canvas.file_preview_plain_complex")).toMatch(/без форматирования/);
    expect(getPpmTranslation("en", "canvas.file_preview_plain_long")).toMatch(/^[\x20-\x7e—…«»]+$/);
    expect(getPpmTranslation("en", "canvas.file_preview_plain_complex")).toMatch(/^[\x20-\x7e—…«»]+$/);
  });

  it("shows the download fallback link or error inside the dialog, not under it", () => {
    const ru = (key: Parameters<typeof getPpmTranslation>[1]) => getPpmTranslation("ru", key);
    expect(filePreviewDownloadNotice(undefined, "Замеры.xlsx", ru)).toBeUndefined();
    expect(filePreviewDownloadNotice({ status: "started" }, "Замеры.xlsx", ru)).toBeUndefined();
    expect(filePreviewDownloadNotice({ status: "error" }, "Замеры.xlsx", ru)).toEqual({
      text: "Не удалось скачать файл.",
      tone: "error",
    });
    expect(
      filePreviewDownloadNotice({ status: "link", url: "https://api.test/f/?download=1" }, "Замеры.xlsx", ru)
    ).toEqual({
      href: "https://api.test/f/?download=1",
      label: "Скачать",
      text: "Не удалось скачать «Замеры.xlsx» напрямую — скачайте по ссылке:",
      tone: "info",
    });
    // Диалог получает исход скачивания и рисует его в своей области сообщения (ссылку щёлкает сам пользователь).
    expect(previewSource).toContain(
      "onDownload: (binding: TPpmCanvasContentBinding) => Promise<TCanvasDownloadResult>;"
    );
    expect(previewSource).toContain("setDownload(await onDownload(binding));");
    expect(previewSource).toMatch(
      /<p className="ppm-file-preview__download" data-tone=\{downloadNotice\.tone\} role="status">/
    );
    expect(previewSource).toMatch(
      /<a\s+download\s+href=\{downloadNotice\.href\}\s+rel="noopener noreferrer"\s+target="_blank"/
    );
    // Кнопка «Скачать» не выключается (фокус не теряется в body и Esc/Tab остаются у диалога) — повтор гасит флаг.
    expect(previewSource).toContain("aria-busy={downloading || undefined}");
    expect(editorSource).toMatch(/<PpmFilePreviewDialog[\s\S]{0,300}onDownload=\{startDownload\}/);
    // Карточка («Скачать» на холсте) — прежнее уведомление холста.
    expect(editorSource).toContain("downloadFile,");
  });
});
