import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { getPpmTranslation, type TPpmTranslationKey } from "@ppm/brand";
import { createPpmContentRefNode, createPpmCanvasNode, serializePpmCanvasNode } from "@ppm/canvas";
import { PPM_RAIL_MENUS, visibleRailMenuItems } from "@/components/ppm-canvas/canvas-toolkit-model";
import {
  CANVAS_VAULT_PICKER_LIMIT,
  boundCardId,
  pickVaultFile,
  isProjectSourceCommand,
  openProjectCodePage,
  projectCodePath,
  runProjectSourceCommand,
  searchVaultFiles,
  settleCanvasSave,
  vaultFileFolder,
  vaultFilesOf,
  type TPpmProjectSourceDeps,
} from "@/components/ppm-canvas/canvas-vault-picker";
import type { TPpmVaultEntry } from "@/services/ppm-vault.service";

// AF2.1, финальная волна (I-1): «Из проекта → Файл» и «Из проекта → Git-объект» — не пустые case, а живые пути.
const read = (name: string) =>
  readFileSync(new URL(`../../core/components/ppm-canvas/${name}`, import.meta.url), "utf8");
const pickerSource = read("canvas-vault-picker.tsx");
const editorSource = read("editor.tsx");
const ru = (key: TPpmTranslationKey) => getPpmTranslation("ru", key);

function vaultEntry(id: string, name: string, overrides: Partial<TPpmVaultEntry> = {}): TPpmVaultEntry {
  return {
    content_hash: "",
    created_at: "2026-09-01T10:00:00+00:00",
    extension: name.includes(".") ? (name.split(".").pop() ?? "") : "",
    id,
    index_policy: "inherit",
    kind: "file",
    mime_type: "application/octet-stream",
    name,
    parent_id: null,
    path: name,
    size_bytes: 10,
    status: "active",
    updated_at: "2026-09-01T10:00:00+00:00",
    version: 1,
    ...overrides,
  };
}

function projectSourceSpies() {
  const calls: string[] = [];
  const deps: TPpmProjectSourceDeps = {
    openPagePicker: () => calls.push("page-picker"),
    openProjectCode: () => calls.push("code-page"),
    openVaultPicker: () => calls.push("vault-picker"),
  };
  return { calls, deps };
}

/** Тело case в CanvasControls — от `case "…":` до его break. */
function caseBody(command: string): string {
  const start = editorSource.indexOf(`case "${command}":`);
  expect(start, command).toBeGreaterThan(0);
  return editorSource.slice(start, editorSource.indexOf("break;", start));
}

describe("«Из проекта» in the rail: every item does something (final wave, I-1)", () => {
  it("runs one real action for every item an editor sees, and nothing for a reader", () => {
    const items = visibleRailMenuItems(PPM_RAIL_MENUS.project, true);
    expect(items.map((item) => item.command)).toEqual([
      "add-work-item",
      "add-work-items-view",
      "add-file",
      "add-git",
      "add-page-ref",
      "build-sprint-map",
    ]);
    const done: Record<string, string[]> = {};
    for (const item of items) {
      if (!isProjectSourceCommand(item.command)) continue;
      const { calls, deps } = projectSourceSpies();
      runProjectSourceCommand(item.command, true, deps);
      done[item.command] = calls;
    }
    // Пункты линии B — через диспетчер, у каждого своё действие.
    expect(done).toEqual({
      "add-file": ["vault-picker"],
      "add-git": ["code-page"],
      "add-page-ref": ["page-picker"],
    });
    // Пункты волны 1 — прежние case CanvasControls, и тоже не пустые: поиск задач и канбан.
    expect(items.filter((item) => !isProjectSourceCommand(item.command)).map((item) => item.command)).toEqual([
      "add-work-item",
      "add-work-items-view",
      "build-sprint-map",
    ]);
    // AF2.2: «Карта спринта» — case блока M в CanvasControls, открывает диалог сборки карты (линия M).
    expect(caseBody("build-sprint-map")).toContain("openSprintMapDialog(");
    expect(caseBody("add-work-item")).toMatch(/if \(canEdit\) setPickerOpen\(true\);/);
    expect(caseBody("add-work-items-view")).toMatch(/if \(canEdit\) createNode\(editor, authorId, "work_items_view",/);
    // Читателю рейка эти пункты не показывает; команда, пришедшая иначе (палитра, чужое событие), тоже ничего не делает.
    expect(visibleRailMenuItems(PPM_RAIL_MENUS.project, false)).toEqual([]);
    const reader = projectSourceSpies();
    for (const command of ["add-page-ref", "add-file", "add-git"] as const)
      runProjectSourceCommand(command, false, reader.deps);
    expect(reader.calls).toEqual([]);
    expect(isProjectSourceCommand("add-note")).toBe(false);
    expect(isProjectSourceCommand("toString")).toBe(false);
  });

  it("wires CanvasControls through the dispatcher: no empty «add-file»/«add-git» case is left", () => {
    expect(editorSource).toMatch(
      /case "add-page-ref":\s+case "add-file":\s+case "add-git":\s+runProjectSourceCommand\(detail\.command, canEdit, \{/
    );
    expect(editorSource).not.toMatch(/case "add-(?:file|git)":\s+break;/);
    expect(editorSource).toContain("openPagePicker: contentActions.openPagePicker,");
    expect(editorSource).toContain("openVaultPicker: projectSources.openVaultPicker,");
    expect(editorSource).toContain("openProjectCode: projectSources.openProjectCode,");
    expect(editorSource).toContain("<PpmCanvasProjectSourcesContext.Provider value={projectSources}>");
  });

  it("«Git-объект» opens the project's Code page once the board is saved", async () => {
    expect(projectCodePath("lab", "p-1")).toBe("/lab/projects/p-1/code");
    const navigate = vi.fn();
    const notices: string[] = [];
    const deps = {
      navigate,
      notify: (message: string) => notices.push(message),
      projectId: "p-1",
      t: ru,
      workspaceSlug: "lab",
    };
    // Через тот же диспетчер, что и у рейки: пункт меню → навигация с этим путём.
    const { deps: handlers } = projectSourceSpies();
    let leaving: Promise<boolean> | undefined;
    runProjectSourceCommand("add-git", true, {
      ...handlers,
      openProjectCode: () => {
        leaving = openProjectCodePage({ ...deps, settleSave: async () => true });
      },
    });
    await expect(leaving).resolves.toBe(true);
    expect(navigate).toHaveBeenCalledWith("/lab/projects/p-1/code");
    // Не сохранилось — остаёмся на холсте и говорим почему.
    await expect(openProjectCodePage({ ...deps, settleSave: async () => false })).resolves.toBe(false);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([ru("canvas.git_leave_unsaved")]);
  });

  it("settles the autosave before leaving: flush when dirty, wait for a save in flight, give up on failure", async () => {
    const sleep = vi.fn(async () => undefined);
    // Нечего сохранять — сразу, без записи.
    const idleFlush = vi.fn(async () => undefined);
    await expect(
      settleCanvasSave({ flush: idleFlush, hasUnsaved: () => false, isSaving: () => false, sleep })
    ).resolves.toBe(true);
    expect(idleFlush).not.toHaveBeenCalled();

    // Несохранённые изменения — тот же flushSave, что и при автосохранении; onWait — один раз.
    let dirty = true;
    const onWait = vi.fn();
    const flush = vi.fn(async () => {
      dirty = false;
    });
    await expect(
      settleCanvasSave({ flush, hasUnsaved: () => dirty, isSaving: () => false, onWait, sleep })
    ).resolves.toBe(true);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(onWait).toHaveBeenCalledTimes(1);

    // Сохранение уже идёт — ждём его, второго запроса не начинаем.
    let inFlight = 2;
    const waitFlush = vi.fn(async () => undefined);
    sleep.mockClear();
    await expect(
      settleCanvasSave({
        flush: waitFlush,
        hasUnsaved: () => inFlight > 0,
        isSaving: () => {
          if (inFlight === 0) return false;
          inFlight -= 1;
          return true;
        },
        sleep,
      })
    ).resolves.toBe(true);
    expect(waitFlush).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledTimes(2);

    // Сохранить не удаётся — не больше двух попыток, затем false (переход отменяется).
    const failing = vi.fn(async () => undefined);
    await expect(
      settleCanvasSave({ flush: failing, hasUnsaved: () => true, isSaving: () => false, sleep })
    ).resolves.toBe(false);
    expect(failing).toHaveBeenCalledTimes(2);

    // Сохранение зависло — по таймауту false.
    sleep.mockClear();
    await expect(
      settleCanvasSave({
        flush: failing,
        hasUnsaved: () => true,
        intervalMs: 100,
        isSaving: () => true,
        sleep,
        timeoutMs: 500,
      })
    ).resolves.toBe(false);
    expect(sleep).toHaveBeenCalledTimes(5);
  });

  it("names the Code page in the rail hint and the save outcome in both languages", () => {
    const git = PPM_RAIL_MENUS.project.items.find((item) => item.command === "add-git");
    expect(git?.hintKey).toBe("canvas.rail.git_hint");
    // Раунд 2 (m-5): без цитаты надписи — у объектов на странице кода только значок, и сама страница только по-русски.
    expect(ru("canvas.rail.git_hint")).toBe("Откроется страница кода проекта — оттуда объект можно положить на холст");
    expect(getPpmTranslation("en", "canvas.rail.git_hint")).toBe(
      "Opens the project's Code page — you can put an object on the canvas from there"
    );
    for (const key of ["canvas.rail.git_hint", "canvas.git_leave_saving", "canvas.git_leave_unsaved"] as const) {
      expect(ru(key), key).toMatch(/[а-яё]/i);
      expect(getPpmTranslation("en", key), key).not.toMatch(/[а-яё]/i);
    }
    // Переход — через роутер приложения после сохранения доски; сохранение — тот же flushSave автосохранения.
    expect(editorSource).toContain("navigate: (path) => router.push(path),");
    expect(editorSource).toMatch(/flush: \(\) => flushSaveRef\.current\(\),/);
    expect(editorSource).toContain("hasUnsaved: () => dirtyRef.current || Boolean(pendingSaveRef.current),");
  });
});

describe("«Из проекта → Файл»: a file from the Vault (final wave, I-1)", () => {
  it("lists files only — not folders — from the whole Vault tree", () => {
    const tree = [
      vaultEntry("folder-1", "Отчёты", {
        children: [
          vaultEntry("a", "Замеры.pdf", { parent_id: "folder-1", path: "Отчёты/Замеры.pdf" }),
          vaultEntry("folder-2", "2026", {
            children: [vaultEntry("b", "План.md", { kind: "markdown", path: "Отчёты/2026/План.md" })],
            kind: "folder",
            path: "Отчёты/2026",
          }),
        ],
        kind: "folder",
      }),
      vaultEntry("c", "Схема.png", { kind: "image" }),
      vaultEntry("q", "Карантин.pdf", { status: "quarantined" }),
    ];
    expect(vaultFilesOf(tree).map((file) => file.id)).toEqual(["a", "b", "c"]);
    expect(vaultFileFolder(vaultEntry("b", "План.md", { path: "Отчёты/2026/План.md" }))).toBe("Отчёты / 2026");
    expect(vaultFileFolder(vaultEntry("c", "Схема.png"))).toBe("");
  });

  it("searches by name on the client, freshest first, at most 50", () => {
    const files = [
      vaultEntry("old", "Отчёт за март.pdf", { updated_at: "2026-03-01T10:00:00+00:00" }),
      vaultEntry("new", "отчёт за сентябрь.docx", { updated_at: "2026-09-20T10:00:00+00:00" }),
      vaultEntry("other", "Схема.png", { updated_at: "2026-09-24T10:00:00+00:00" }),
    ];
    expect(searchVaultFiles(files, "").hits.map((file) => file.id)).toEqual(["other", "new", "old"]);
    expect(searchVaultFiles(files, "  ОТЧЁТ ")).toEqual({ hits: [files[1], files[0]], total: 2 });
    expect(searchVaultFiles(files, "нет такого")).toEqual({ hits: [], total: 0 });
    const many = Array.from({ length: 60 }, (_, index) =>
      vaultEntry(`f${index}`, `Кадр ${index}.png`, {
        updated_at: `2026-09-${String((index % 28) + 1).padStart(2, "0")}T10:00:00+00:00`,
      })
    );
    const limited = searchVaultFiles(many, "кадр");
    expect(CANVAS_VAULT_PICKER_LIMIT).toBe(50);
    expect(limited.total).toBe(60);
    expect(limited.hits).toHaveLength(50);
    expect(limited.hits[0].updated_at >= limited.hits[49].updated_at).toBe(true);
  });

  it("finds the card already bound to a file, so a repeated pick selects it instead of a duplicate", () => {
    // Идентификаторы привязок — UUID (схема узла их проверяет).
    const ENTRY_1 = "11111111-1111-4111-8111-111111111111";
    const ENTRY_2 = "22222222-2222-4222-8222-222222222222";
    const ASSET_1 = "33333333-3333-4333-8333-333333333333";
    const card = (entityType: "attachment" | "vault_file", entityId: string) =>
      serializePpmCanvasNode(
        createPpmContentRefNode({
          authorId: "user-1",
          binding: {
            binding_id: `44444444-4444-4444-8444-${entityId.slice(-12)}`,
            entity_id: entityId,
            entity_type: entityType,
            source_version: "1",
          },
          extension: ".pdf",
          kind: "pdf",
          sourceUrl: "/lab/projects/p/knowledge?entry_id=e",
          title: "Замеры.pdf",
        })
      );
    const shapes = [
      { id: "shape:geo", props: {}, type: "geo" },
      {
        id: "shape:note",
        props: { node: serializePpmCanvasNode(createPpmCanvasNode({ authorId: "u", kind: "note", title: "x" })) },
        type: "ppm-canvas-node",
      },
      { id: "shape:attachment", props: { node: card("attachment", ASSET_1) }, type: "ppm-canvas-node" },
      { id: "shape:file", props: { node: card("vault_file", ENTRY_1) }, type: "ppm-canvas-node" },
      { id: "shape:broken", props: { node: "{not json" }, type: "ppm-canvas-node" },
    ];
    expect(boundCardId(shapes, "vault_file", ENTRY_1)).toBe("shape:file");
    expect(boundCardId(shapes, "vault_file", ENTRY_2)).toBeUndefined();
    expect(boundCardId(shapes, "attachment", ASSET_1)).toBe("shape:attachment");
    expect(boundCardId(shapes, "vault_file", ASSET_1)).toBeUndefined();
  });

  it("is a canvas modal: portal, aria-modal, keys by e.code, Tab trap, Enter only from the search field", () => {
    expect(pickerSource).toContain("createPortal(");
    expect(pickerSource).toMatch(/aria-modal="true"[\s\S]{0,300}data-ppm-canvas-modal=""[\s\S]{0,120}role="dialog"/);
    expect(pickerSource).toContain('event.code === "Escape"');
    expect(pickerSource).toContain('event.code === "Tab"');
    expect(pickerSource).not.toMatch(/event\.key\b/);
    expect(pickerSource).toMatch(
      /\(event\.code === "Enter" \|\| event\.code === "NumpadEnter"\) &&\s+event\.target === inputRef\.current/
    );
    // Ошибка — не «пусто»: своё сообщение и «Повторить»; пустое Хранилище и «не найдено» — разные тексты.
    expect(pickerSource).toContain('ppmT("canvas.vault_load_error")');
    expect(pickerSource).toContain('ppmT("vault.retry")');
    expect(pickerSource).toContain('ppmT("canvas.vault_empty")');
    expect(pickerSource).toContain('ppmT("canvas.vault_search_empty")');
    // «Загрузить с компьютера…» — скрытый выбор нескольких файлов с форматами Хранилища.
    expect(pickerSource).toMatch(
      /type="file"[\s\S]{0,200}multiple[\s\S]{0,200}accept=\{PPM_VAULT_ACCEPT\.join\(","\)\}/
    );
    expect(pickerSource).not.toMatch(/fetch\(|https?:\/\//);
  });

  it("places a picked file through the B4 path and uploads through ⌘U's path; editors only, one focus effect", () => {
    const block = editorSource.slice(
      editorSource.indexOf("// ── AF2.1 B: (final) «Из проекта» — файл из Хранилища и Git-объект ──"),
      editorSource.indexOf(
        "// ── /AF2.1 B ──",
        editorSource.indexOf("// ── AF2.1 B: (final) «Из проекта» — файл из Хранилища и Git-объект ──")
      )
    );
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain("vaultFilesOf((await vaultService.getVault(workspaceId, projectId)).entries)");
    expect(block).toContain('await addUploadedContent("vault_file", entry.id, 0, center);');
    expect(block).toContain('boundCardId(activeEditor.getCurrentPageShapes(), "vault_file", entry.id)');
    expect(block).toMatch(/putExternalContent\(\{\s+type: "files",/);
    expect(block).toMatch(/if \(vaultPickerOpen && !effectiveCanEdit\) \{\s+setVaultPickerOpen\(false\);/);
    expect(editorSource).toContain(
      "const canvasModalOpen = pagePickerOpen || vaultPickerOpen || previewBinding !== undefined;"
    );
    expect(editorSource).toMatch(/\{grammarV2 && vaultPickerOpen && \(\s+<PpmCanvasVaultPicker/);
  });

  it("names the picker in both languages", () => {
    expect(ru("canvas.vault_pick_title")).toBe("Файл из Хранилища");
    expect(ru("canvas.vault_pick_upload")).toBe("Загрузить с компьютера…");
    for (const key of [
      "canvas.vault_pick_title",
      "canvas.vault_search_placeholder",
      "canvas.vault_search_empty",
      "canvas.vault_empty",
      "canvas.vault_load_error",
      "canvas.vault_search_limited",
      "canvas.vault_pick_upload",
      "canvas.vault_file_placed",
      "canvas.vault_file_on_board",
      "canvas.vault_file_place_error",
      "canvas.vault_picker_readonly",
    ] as const) {
      expect(ru(key), key).toMatch(/[а-яё]/i);
      expect(getPpmTranslation("en", key), key).not.toMatch(/[а-яё]/i);
    }
  });
});

// Раунд 2 (m-3): отказ размещения виден в самом выборе — уведомление холста лежит под подложкой диалога.
describe("a failed placement from the Vault picker (final wave, round 2)", () => {
  it("names the failure inside the picker, keeps it open for a retry, and closes it once the card is placed", async () => {
    const file = vaultEntry("a", "Замеры.pdf");
    const errors: Array<string | undefined> = [];
    const onClose = vi.fn();
    const deps = { errorText: "ошибка", onClose, setError: (message: string | undefined) => errors.push(message) };
    await expect(
      pickVaultFile(file, {
        ...deps,
        onPick: async () => {
          throw new Error("bind failed");
        },
      })
    ).resolves.toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(errors).toEqual([undefined, "ошибка"]);
    // Повтор удался: сообщение снято, выбор закрыт.
    const onPick = vi.fn(async () => undefined);
    await expect(pickVaultFile(file, { ...deps, onPick })).resolves.toBe(true);
    expect(onPick).toHaveBeenCalledWith(file);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(errors.at(-1)).toBeUndefined();
  });

  it("renders the message in the picker's message area and clears it when the search changes", () => {
    expect(pickerSource).toMatch(/\{pickError && \(\s+<p className="ppm-canvas-page-picker__error" role="alert">/);
    expect(pickerSource).toContain(
      'errorText: fillCanvasTemplate(ppmT("canvas.vault_pick_place_error"), { name: file.name }),'
    );
    expect(pickerSource).toMatch(/setQuery\(event\.currentTarget\.value\);[\s\S]{0,80}setPickError\(undefined\);/);
    expect(ru("canvas.vault_pick_place_error").replace("{name}", "Замеры.pdf")).toBe(
      "Не удалось добавить «Замеры.pdf» на холст. Повторите или выберите другой файл."
    );
    expect(getPpmTranslation("en", "canvas.vault_pick_place_error")).not.toMatch(/[а-яё]/i);
  });
});
