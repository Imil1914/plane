// Мультидоска (живая проверка AF2.1, 18:27): workspace.tsx держит смонтированным редактор tldraw каждой открытой вкладки,
// и все они были «в фокусе» (autoFocus при монтировании, скрытые вкладки никто не выключал). tldraw 3.15.6 вешает
// вставку/копирование (document) и горячие клавиши (hotkeys-js на body) на каждый редактор «в фокусе» → одна ⌘V загрузила
// картинку в Хранилище трижды и положила карточку на каждую открытую доску; ⌘Z, Delete и буквы инструментов — так же.
// Теперь «в фокусе» только редактор активной вкладки; вставка, брошенные файлы и ссылки «На холст» — только у него.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isCanvasDomFocusLost,
  PPM_CANVAS_GIT_LINK_PARAMS,
  PPM_CANVAS_VAULT_LINK_PARAMS,
  shouldFocusCanvasEditor,
  syncCanvasEditorFocus,
  takeCanvasLinkParams,
} from "@/components/ppm-canvas/file-preview";

const dir = new URL("../../core/components/ppm-canvas/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
const editorSource = read("editor.tsx");
const workspaceSource = read("workspace.tsx");
const minimalSource = read("minimal-workspace.tsx");

// Поддельный DOM без jsdom: closest отвечает ровно на два селектора, которые проверяет isCanvasDomFocusLost.
const body: { ownerDocument?: { body: unknown } } = {};
body.ownerDocument = { body };
const ownContainer = { board: "active" };
const otherContainer = { board: "hidden" };
function element({ container = null, hidden = false }: { container?: object | null; hidden?: boolean } = {}) {
  return {
    closest: (selector: string) =>
      selector === '[aria-hidden="true"]' ? (hidden ? {} : null) : selector === ".tl-container" ? container : null,
    ownerDocument: { body },
  } as unknown as Element;
}

function fakeEditor() {
  const calls: string[] = [];
  const editor = {
    blur: () => {
      calls.push("blur");
      return editor;
    },
    focus: (options?: { focusContainer?: boolean }) => {
      calls.push(`focus:${String(options?.focusContainer)}`);
      return editor;
    },
    getContainer: () => ownContainer,
  } as unknown as Parameters<typeof syncCanvasEditorFocus>[0];
  return { calls, editor };
}

/** Эффект верхнего уровня редактора, в теле которого есть `marker`: от его `useEffect(` до следующего. */
function effectAround(source: string, marker: string): string {
  const at = source.indexOf(marker);
  expect(at, marker).toBeGreaterThan(-1);
  return source.slice(source.lastIndexOf("\n  useEffect(", at), source.indexOf("\n  useEffect(", at));
}

describe("multi-board: only the active tab's editor is focused", () => {
  it("decides focus once for both reasons: the active tab and no canvas dialog open", () => {
    expect(shouldFocusCanvasEditor({ isActive: true, modalOpen: false })).toBe(true);
    expect(shouldFocusCanvasEditor({ isActive: true, modalOpen: true })).toBe(false);
    expect(shouldFocusCanvasEditor({ isActive: false, modalOpen: false })).toBe(false);
    expect(shouldFocusCanvasEditor({ isActive: false, modalOpen: true })).toBe(false);
  });

  it("counts DOM focus as lost only where nobody owns it: body, a hidden tab panel, another board's canvas", () => {
    const own = ownContainer as unknown as Element;
    expect(isCanvasDomFocusLost(null, own)).toBe(true);
    expect(isCanvasDomFocusLost(body as unknown as Element, own)).toBe(true);
    // Панель скрытой вкладки (aria-hidden="true") и холст другой доски (Safari не фокусирует кнопку вкладки по щелчку).
    expect(isCanvasDomFocusLost(element({ hidden: true }), own)).toBe(true);
    expect(isCanvasDomFocusLost(element({ container: otherContainer }), own)).toBe(true);
    expect(isCanvasDomFocusLost(element({ container: otherContainer, hidden: true }), own)).toBe(true);
    // Кнопка вкладки, рейка, шапка — и свой холст (поле заметки на нём): фокус на месте, не отнимаем.
    expect(isCanvasDomFocusLost(element(), own)).toBe(false);
    expect(isCanvasDomFocusLost(element({ container: ownContainer }), own)).toBe(false);
  });

  it("takes DOM focus into the new board when it stayed in the old board's canvas — whatever the tab order", () => {
    const { calls, editor } = fakeEditor();
    // Эффект новой вкладки раньше blur прежней: фокус ещё в холсте прежней доски (или уже в её скрытой панели).
    syncCanvasEditorFocus(editor, { isActive: true, modalOpen: false }, element({ container: otherContainer }));
    syncCanvasEditorFocus(editor, { isActive: true, modalOpen: false }, element({ hidden: true }));
    // Фокус уже в своём холсте — контейнер не дёргаем.
    syncCanvasEditorFocus(editor, { isActive: true, modalOpen: false }, element({ container: ownContainer }));
    expect(calls).toEqual(["focus:true", "focus:true", "focus:false"]);
  });

  it("blurs a hidden tab's editor even with no dialog open, and never takes DOM focus from the tab button", () => {
    const tabButton = element();
    const { calls, editor } = fakeEditor();
    // Скрытая вкладка: выключен, даже если фокус потерян (body/null) — её контейнер фокус не забирает никогда.
    syncCanvasEditorFocus(editor, { isActive: false, modalOpen: false }, tabButton);
    syncCanvasEditorFocus(editor, { isActive: false, modalOpen: false }, body as unknown as Element);
    syncCanvasEditorFocus(editor, { isActive: false, modalOpen: false }, null);
    syncCanvasEditorFocus(editor, { isActive: false, modalOpen: true }, tabButton);
    // Вкладка стала активной: горячие клавиши работают сразу, DOM-фокус остаётся на кнопке вкладки.
    syncCanvasEditorFocus(editor, { isActive: true, modalOpen: false }, tabButton);
    // Диалог холста на активной вкладке по-прежнему выключает редактор.
    syncCanvasEditorFocus(editor, { isActive: true, modalOpen: true }, tabButton);
    expect(calls).toEqual(["blur", "blur", "blur", "blur", "focus:false", "blur"]);
  });

  it("gives every open tab its own isActive and creates hidden tabs unfocused", () => {
    const panels = workspaceSource.slice(
      workspaceSource.indexOf("{openBoardIds.map((boardId) => ("),
      workspaceSource.indexOf("</main>")
    );
    expect(panels).toContain("<PpmCanvasEditor");
    expect(panels).toContain("isActive={boardId === activeBoardId}");
    expect(workspaceSource.match(/<PpmCanvasEditor\b/g)).toHaveLength(1);
    // Одна доска без вкладок (minimal) — всегда активна: проп не передаётся, по умолчанию true.
    expect(minimalSource).toContain("<PpmCanvasEditor");
    expect(minimalSource).not.toContain("isActive=");
    expect(editorSource).toContain("isActive?: boolean;");
    expect(editorSource).toMatch(/canEdit,\s+isActive = true,\s+onEditabilityChange,/);
    // autoFocus tldraw читает при создании редактора: скрытая вкладка создаётся «не в фокусе».
    const tldraw = editorSource.slice(editorSource.indexOf("<Tldraw\n"), editorSource.indexOf("</Tldraw>"));
    expect(tldraw).toContain("autoFocus={isActive}");
  });

  it("toggles tldraw focus in one effect only — the tab and the dialogs cannot fight", () => {
    expect(editorSource).toMatch(
      /useEffect\(\(\) => \{\s+if \(editor\) syncCanvasEditorFocus\(editor, \{ isActive, modalOpen: canvasModalOpen \}\);\s+\}, \[canvasModalOpen, editor, isActive\]\);/
    );
    expect(editorSource.match(/syncCanvasEditorFocus\(/g)).toHaveLength(1);
    // Никаких других прямых переключений фокуса tldraw в редакторе доски (строки-комментарии не в счёт).
    const code = editorSource.replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\b(?:activeEditor|editor|mounted)\.(?:blur|focus)\(/);
  });

  it("keeps hidden tabs out of paste, dropped files and «На холст» links", () => {
    expect(editorSource).toMatch(/const isActiveRef = useRef\(isActive\);\s+isActiveRef\.current = isActive;/);
    const deps = editorSource.slice(
      editorSource.indexOf("externalContentDepsRef.current = {"),
      editorSource.indexOf("const getExternalContentDeps = useCallback(")
    );
    expect(deps).toMatch(/^\s+isActive,$/m);

    const drop = editorSource.slice(
      editorSource.indexOf("const handleFileDrop = useCallback("),
      editorSource.indexOf("const createSemanticEdge = useCallback(")
    );
    expect(drop).toMatch(/if \(!isActiveRef\.current\) \{\s+event\.dataTransfer\.dropEffect = "none";\s+return;\s+\}/);
    const guard = drop.indexOf("if (!isActiveRef.current)");
    // После preventDefault (браузер не открывает файл вместо холста), до подсказки, уведомления, загрузки и диалога.
    expect(guard).toBeGreaterThan(drop.indexOf("event.preventDefault();"));
    for (const later of [
      "showDropHintRef.current(",
      "setFileDropNotice(true)",
      "dropFilesV2Ref.current(",
      "setPendingFileDrop(",
    ])
      expect(guard, later).toBeLessThan(drop.indexOf(later));

    // Возврат со страниц Хранилища и кода («На холст» → ?ppm_vault_*/ppm_git_*) — карточку кладёт только активная вкладка.
    for (const marker of ["PPM_CANVAS_VAULT_LINK_PARAMS)", "PPM_CANVAS_GIT_LINK_PARAMS)"]) {
      const effect = effectAround(editorSource, marker);
      expect(effect, marker).toContain(
        'if (!editor || !isActive || !effectiveCanEdit || syncStatus !== "saved") return;'
      );
      expect(effect.slice(effect.lastIndexOf("}, [")), marker).toMatch(/\bisActive\b/);
    }
  });
});

// Ссылка «На холст» раньше удалялась из адреса только после ответа сервера: переключение A→B во время запроса клало
// карточку на две доски, A→B→A — привязывало дважды (зависимость isActive добавила повторы эффекта).
describe("«На холст»: the link is taken from the address once, before the first await", () => {
  const vaultSearch =
    "?board=b1&ppm_vault_entry=e1&ppm_vault_extension=pdf&ppm_vault_title=%D0%A1%D1%85%D0%B5%D0%BC%D0%B0.pdf" +
    "&ppm_vault_url=%2Fws%2Fprojects%2Fp%2Fknowledge%3Fentry_id%3De1&ppm_vault_version=3";

  it("hands the link to the caller and keeps the rest of the address, so a second reader finds nothing", () => {
    const first = takeCanvasLinkParams(vaultSearch, PPM_CANVAS_VAULT_LINK_PARAMS);
    expect(first.values).toEqual({
      ppm_vault_entry: "e1",
      ppm_vault_extension: "pdf",
      ppm_vault_title: "Схема.pdf",
      ppm_vault_url: "/ws/projects/p/knowledge?entry_id=e1",
      ppm_vault_version: "3",
    });
    expect(first.search).toBe("?board=b1");
    // Повтор эффекта или редактор другой вкладки читают уже переписанный адрес.
    expect(takeCanvasLinkParams(first.search, PPM_CANVAS_VAULT_LINK_PARAMS)).toEqual({
      search: "?board=b1",
      values: {},
    });
    // git: все семь параметров, включая необязательный ppm_git_work_item; пустой остаток — "".
    const git = takeCanvasLinkParams(
      "?ppm_git_id=g1&ppm_git_provider=github&ppm_git_repository=o%2Fr&ppm_git_title=Fix&ppm_git_type=pull_request" +
        "&ppm_git_url=https%3A%2F%2Fgit.test%2Fpr%2F1&ppm_git_work_item=ROBOT-7",
      PPM_CANVAS_GIT_LINK_PARAMS
    );
    expect(git.search).toBe("");
    expect(git.values).toMatchObject({ ppm_git_id: "g1", ppm_git_type: "pull_request", ppm_git_work_item: "ROBOT-7" });
    expect(takeCanvasLinkParams("", PPM_CANVAS_GIT_LINK_PARAMS)).toEqual({ search: "", values: {} });
  });

  it("strips every parameter the Vault and Code pages put into the link", () => {
    for (const [route, keys, prefix] of [
      ["ppm-vault/route.tsx", PPM_CANVAS_VAULT_LINK_PARAMS, "ppm_vault_"],
      ["ppm-git/route.tsx", PPM_CANVAS_GIT_LINK_PARAMS, "ppm_git_"],
    ] as const) {
      const source = readFileSync(new URL(`../../core/components/${route}`, import.meta.url), "utf8");
      const produced = new Set(source.match(new RegExp(`\\b${prefix}[a-z_]+\\b`, "g")));
      expect(new Set(keys), route).toEqual(produced);
    }
  });

  it("rewrites the address before the first await in both effects, keeping the history state", () => {
    for (const [marker, processed] of [
      ["PPM_CANVAS_VAULT_LINK_PARAMS)", "processedVaultProjectionRef"],
      ["PPM_CANVAS_GIT_LINK_PARAMS)", "processedGitProjectionRef"],
    ] as const) {
      const effect = effectAround(editorSource, marker);
      const take = effect.indexOf("if (!replaceCanvasSearch(link.search)) return;");
      expect(take, marker).toBeGreaterThan(-1);
      expect(take, marker).toBeLessThan(effect.indexOf("await "));
      // Уже положенная на эту доску ссылка тоже забирается из адреса — и не кладётся второй раз.
      expect(take, marker).toBeLessThan(effect.indexOf(`if (${processed}.current === projectionKey) return;`));
      expect(effect, marker).not.toContain("replaceState");
    }
    const helper = editorSource.slice(editorSource.indexOf("function replaceCanvasSearch("));
    expect(helper).toMatch(/try \{\s+window\.history\.replaceState\(\s*window\.history\.state,\s*"",/);
    expect(helper).toMatch(/\} catch \{\s+return false;\s+\}/);
    expect(editorSource).not.toContain("window.history.replaceState(null");
  });
});
