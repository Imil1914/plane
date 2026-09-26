// AF2.2 F2: фундамент «Живой карты». Команда «Карта спринта» (рейка «Из проекта», палитра v2, пустая доска v2);
// провайдер вокруг <Tldraw>; правая колонка в CanvasControls; слой связей и диалог сборки — дочерние <Tldraw>;
// размеченные блоки линий M и C сбалансированы; living-map.css — только v2; глубокая ссылка ?shape= — только у
// активной вкладки после загрузки доски.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { getPpmTranslation } from "@ppm/brand";
import { isCanvasCommandAllowedReadOnly } from "@/components/ppm-canvas/board-workspace-state";
import { PPM_RAIL_MENUS, visibleRailMenuItems } from "@/components/ppm-canvas/canvas-toolkit-model";
import { PPM_CANVAS_COMMANDS } from "@/components/ppm-canvas/commands";
import {
  PPM_LIVING_MAP_DEFAULT,
  readTrafficLightPreference,
  subscribeTrafficLight,
  trafficLightStorageKey,
  writeTrafficLightPreference,
} from "@/components/ppm-canvas/living-map/living-map-context";
import {
  canvasShapeLinkPath,
  revealCanvasShape,
  takeCanvasShapeLink,
} from "@/components/ppm-canvas/living-map/shape-link";

const dir = new URL("../../core/components/ppm-canvas/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
const editor = read("editor.tsx");
const workspace = read("workspace.tsx");
const rail = read("canvas-rail.tsx");
const types = read("living-map/living-map-types.ts");
const provider = read("living-map/living-map-provider.tsx");
const css = read("living-map/living-map.css");
// Formatting-proof source checks, as in rail-v2.test.ts: oxfmt may wrap calls and add trailing commas.
const norm = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .replace(/([([{]) /g, "$1")
    .replace(/ ([)\]}])/g, "$1")
    .replace(/,([)\]}])/g, "$1");
const has = (source: string, needle: string) => expect(norm(source), needle).toContain(norm(needle));

function functionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

function sliceBetween(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start, from).toBeGreaterThan(-1);
  const end = source.indexOf(to, start + from.length);
  expect(end, to).toBeGreaterThan(start);
  return source.slice(start, end);
}

function blocks(source: string, lane: "F" | "M" | "C"): { closed: number; opened: number } {
  return {
    closed: source.split(`── /AF2.2 ${lane} ──`).length - 1,
    opened: source.split(`── AF2.2 ${lane}:`).length - 1,
  };
}

// Every selector of a stylesheet (comma lists split; @-rules and keyframe steps skipped).
function cssSelectors(source: string): string[] {
  const flat = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
  return [...flat.matchAll(/([^{}]+)\{/g)]
    .map((match) => match[1].trim())
    .filter((prelude) => !prelude.startsWith("@") && !/^(?:from|to|\d+(?:\.\d+)?%)$/.test(prelude))
    .flatMap((prelude) => prelude.split(",").map((selector) => selector.trim()));
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    values,
  };
}

function throwingStorage() {
  return {
    getItem: (): string | null => {
      throw new Error("denied");
    },
    setItem: (): void => {
      throw new Error("denied");
    },
  };
}

// A tldraw editor reduced to what revealCanvasShape calls; shapes are page boxes by id.
function fakeEditor(boxes: Record<string, { h: number; w: number; x: number; y: number }>) {
  const calls: string[] = [];
  const fake = {
    centerOnPoint: (point: { x: number; y: number }, options?: { animation?: { duration: number } }) => {
      calls.push(`center ${point.x},${point.y}${options?.animation ? " animated" : ""}`);
      return fake;
    },
    getShape: (id: string) => (boxes[id] ? { id } : undefined),
    getShapePageBounds: (id: string) => {
      const box = boxes[id];
      return box ? { center: { x: box.x + box.w / 2, y: box.y + box.h / 2 } } : undefined;
    },
    select: (id: string) => {
      calls.push(`select ${id}`);
      return fake;
    },
  };
  return { calls, editor: fake as unknown as Parameters<typeof revealCanvasShape>[0] };
}

describe("AF2.2 F2: «Карта спринта» — команда, рейка, палитра, пустая доска", () => {
  it("declares build-sprint-map once, as an editing command in both designs", () => {
    expect(PPM_CANVAS_COMMANDS).toContain("build-sprint-map");
    expect(new Set(PPM_CANVAS_COMMANDS).size).toBe(PPM_CANVAS_COMMANDS.length);
    expect(isCanvasCommandAllowedReadOnly("build-sprint-map", true)).toBe(false);
    expect(isCanvasCommandAllowedReadOnly("build-sprint-map", false)).toBe(false);
  });

  it("closes «Из проекта» with «Карта спринта» for editors only, with its hint, source and icon", () => {
    expect(PPM_RAIL_MENUS.project.items.at(-1)).toEqual({
      command: "build-sprint-map",
      labelKey: "canvas.af22.sprint_map",
      hintKey: "canvas.af22.sprint_map_hint",
      sourceKey: "canvas.af22.source_sprints",
    });
    expect(visibleRailMenuItems(PPM_RAIL_MENUS.project, false)).toEqual([]);
    has(rail, '"build-sprint-map": MapIcon');
    expect(getPpmTranslation("ru", "canvas.af22.sprint_map")).toBe("Карта спринта");
    expect(getPpmTranslation("ru", "canvas.af22.source_sprints")).toBe("Спринты");
  });

  it("offers it in the v2 command palette, among the commands of an editable board", () => {
    const block = sliceBetween(workspace, "// ── AF2.2 F: «Карта спринта»", "// ── /AF2.2 F ──");
    has(block, '...(designV2 ? [{ command: "build-sprint-map" as const, id: "build-sprint-map",');
    has(block, 'label: ppmT("canvas.af22.sprint_map")');
    expect(sliceBetween(workspace, "...(activeBoardEditReady", 'command: "undo" as const')).toContain(
      "// ── AF2.2 F: «Карта спринта»"
    );
  });

  it("adds «Собрать карту спринта» to an editor's empty v2 board, through the same command", () => {
    const controls = functionSource(editor, "CanvasControls");
    const empty = controls.slice(controls.indexOf("{shapeCount === 0 && ("));
    has(empty, "{grammarV2 && canEdit && (");
    has(empty, 'onClick={() => dispatchPpmCanvasCommand({ boardId, command: "build-sprint-map" })}');
    has(empty, '{ppmT("canvas.af22.empty_sprint_map")}');
    expect(getPpmTranslation("ru", "canvas.af22.empty_sprint_map")).toBe("Собрать карту спринта");
  });

  it("hands the command to line M inside its block of CanvasControls (an editor under v2 only)", () => {
    // The imports block of line M also names «Карта спринта» — anchor on the command block's own marker.
    const block = sliceBetween(editor, "// ── AF2.2 M: команда build-sprint-map", "// ── /AF2.2 M ──");
    has(block, 'case "build-sprint-map":');
    has(block, "openSprintMapDialog(");
    expect(block).toMatch(/\bcanEdit\b/);
    expect(block).toMatch(/\bgrammarV2\b/);
  });
});

describe("AF2.2 F2: точки монтирования линий M и C", () => {
  it("wraps <Tldraw> in the living-map provider, built from the editor's own state", () => {
    const open = editor.indexOf("<PpmLivingMapProvider args={livingMapArgs}>");
    expect(open).toBeGreaterThan(-1);
    expect(open).toBeLessThan(editor.indexOf("<Tldraw\n"));
    expect(editor.indexOf("</PpmLivingMapProvider>")).toBeGreaterThan(editor.indexOf("</Tldraw>"));
    const body = sliceBetween(
      editor,
      "// ── AF2.2 F: «Живая карта» — окружение",
      "const components = useMemo<TLComponents>("
    );
    for (const needle of [
      "canEdit: effectiveCanEdit,",
      "enabled: grammarV2,",
      "loaded: livingMapLoaded,",
      "registerBindings: registerLivingMapBindings,",
      "onBoardCreated: (board) => onBoardCreatedRef.current?.(board),",
      "for (const binding of bindings) queuedBindingActivationsRef.current.add(binding.binding_id);",
      "scheduleSaveRef.current();",
      "...livingMapArgsM,",
      "...livingMapArgsC,",
    ])
      has(body, needle);
    expect(body).toMatch(/\n\s+isActive,\n/);
    has(provider, "const map = useLivingMapFacts(args);");
    has(provider, "const changes = useBoardChanges(args);");
    has(provider, "<PpmLivingMapContext.Provider value={value}>{children}</PpmLivingMapContext.Provider>");
  });

  it("mounts the relations layer and the sprint-map dialog as leaf children of <Tldraw>, never in the components memo", () => {
    const tldraw = editor.slice(editor.indexOf("<Tldraw\n"), editor.indexOf("</Tldraw>"));
    expect(tldraw).toMatch(/\{grammarV2 &&[^\n]*<PpmTaskRelationsLayer\b/);
    expect(tldraw).toMatch(/\{grammarV2 &&[^\n]*<PpmSprintMapDialog\b/);
    const memo = editor.slice(
      editor.indexOf("const components = useMemo<TLComponents>("),
      editor.indexOf("const projectionContext = useMemo(")
    );
    for (const name of ["PpmTaskRelationsLayer", "PpmSprintMapDialog", "PpmLivingMapProvider"])
      expect(memo, name).not.toContain(name);
  });

  it("puts the right column next to «Доска · Объектов» under v2 and keeps v1's pill as it was", () => {
    const controls = functionSource(editor, "CanvasControls");
    expect(controls).toMatch(
      /\{grammarV2 \? \(\s*<div className="ppm-living-map-aside">[\s\S]*?\) : \(?\s*boardInfo\s*\)?\}/
    );
    const aside = sliceBetween(controls, '<div className="ppm-living-map-aside">', "{/* ── /AF2.2 F ── */}");
    const bar = sliceBetween(aside, '<div className="ppm-living-map-aside__bar">', "{boardInfo}");
    has(bar, "<PpmTrafficLightToggle");
    has(bar, "<PpmChangesButton");
    const panels = aside.slice(aside.indexOf("{boardInfo}"));
    has(panels, "<PpmChangesPanel");
    has(panels, "<PpmNotOnMapTray");
    has(controls, 'const boardInfo = (<div className="ppm-canvas-board-info">');
    expect(controls.split('<div className="ppm-canvas-board-info">').length - 1).toBe(1);
  });

  it("marks balanced F, M and C blocks in editor.tsx, workspace.tsx and the shared types", () => {
    for (const [lane, minimum] of [
      ["F", 5],
      ["M", 6],
      ["C", 4],
    ] as const) {
      const count = blocks(editor, lane);
      expect(count.opened, `editor ${lane}`).toBeGreaterThanOrEqual(minimum);
      expect(count.closed, `editor ${lane}`).toBe(count.opened);
    }
    expect(blocks(workspace, "F")).toEqual({ closed: 1, opened: 1 });
    for (const [lane, minimum] of [
      ["M", 4],
      ["C", 2],
    ] as const) {
      const count = blocks(types, lane);
      expect(count.opened, `types ${lane}`).toBeGreaterThanOrEqual(minimum);
      expect(count.closed, `types ${lane}`).toBe(count.opened);
    }
  });

  it("imports living-map.css after the AF2.1 stylesheets", () => {
    const order = [
      'import "./canvas-v2.css";',
      'import "./canvas-toolkit.css";',
      'import "./canvas-content.css";',
      'import "./living-map/living-map.css";',
    ].map((line) => editor.indexOf(line));
    expect(order[0]).toBeGreaterThan(0);
    for (let index = 1; index < order.length; index++) expect(order[index]).toBeGreaterThan(order[index - 1]);
  });

  it("keeps living-map.css inside the v2 canvas grammar, in one F, M and C block each", () => {
    const selectors = cssSelectors(css);
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors)
      expect(selector, selector).toMatch(/^:where\(html\[data-ppm-design="v2"\]\) \[data-ppm-canvas-grammar="v2"\]/);
    expect(css).not.toMatch(/:where\([^)]*,/);
    expect([...css.matchAll(/\/\* ── ([FMC]): /g)].map((match) => match[1])).toEqual(["F", "M", "C"]);
    for (const lane of ["F", "M", "C"]) expect(css.split(`/* ── /${lane} ── */`).length - 1, lane).toBe(1);
  });

  it("gives every lane its contracted module and export", () => {
    for (const [file, name] of [
      ["living-map/living-map-facts.ts", "useLivingMapFacts"],
      ["living-map/board-changes.ts", "useBoardChanges"],
      ["living-map/task-relations-layer.tsx", "PpmTaskRelationsLayer"],
      ["living-map/traffic-light-toggle.tsx", "PpmTrafficLightToggle"],
      ["living-map/not-on-map-tray.tsx", "PpmNotOnMapTray"],
      ["living-map/map-assembly-dialog.tsx", "openSprintMapDialog"],
      ["living-map/map-assembly-dialog.tsx", "PpmSprintMapDialog"],
      ["living-map/changes-button.tsx", "PpmChangesButton"],
      ["living-map/changes-panel.tsx", "PpmChangesPanel"],
      ["living-map/living-map-provider.tsx", "PpmLivingMapProvider"],
    ] as const)
      expect(read(file), `${file}: ${name}`).toMatch(new RegExp(`export (?:function|const) ${name}\\b`));
    // The provider imports both hooks; a hook importing the context back would be an import cycle.
    for (const file of ["living-map/living-map-facts.ts", "living-map/board-changes.ts"])
      expect(read(file), file).not.toContain("./living-map-context");
  });

  it("starts every living-map view from safe defaults: no facts, no changes, «Светофор» on, nothing enabled", () => {
    expect(PPM_LIVING_MAP_DEFAULT.trafficLight).toBe(true);
    expect(PPM_LIVING_MAP_DEFAULT.facts.size).toBe(0);
    expect(PPM_LIVING_MAP_DEFAULT.mapSections.size).toBe(0);
    expect(PPM_LIVING_MAP_DEFAULT.changes.count).toBe(0);
    expect(PPM_LIVING_MAP_DEFAULT.changes.byShapeId.size).toBe(0);
    expect(PPM_LIVING_MAP_DEFAULT.args).toMatchObject({
      canEdit: false,
      enabled: false,
      isActive: false,
      loaded: false,
    });
  });

  it("remembers «Светофор» per user in the browser, on by default, even when storage is denied", () => {
    const storage = memoryStorage();
    expect(readTrafficLightPreference(storage, "af22-user-a")).toBe(true);
    writeTrafficLightPreference(storage, "af22-user-a", false);
    expect(storage.values.get(trafficLightStorageKey("af22-user-a"))).toBe("off");
    expect(readTrafficLightPreference(storage, "af22-user-a")).toBe(false);
    expect(
      readTrafficLightPreference(memoryStorage({ [trafficLightStorageKey("af22-user-b")]: "off" }), "af22-user-b")
    ).toBe(false);
    expect(readTrafficLightPreference(storage, "af22-user-c")).toBe(true);
    const denied = throwingStorage();
    expect(readTrafficLightPreference(denied, "af22-user-d")).toBe(true);
    writeTrafficLightPreference(denied, "af22-user-d", false);
    expect(readTrafficLightPreference(denied, "af22-user-d")).toBe(false);
    expect(trafficLightStorageKey("user 1")).toBe("ppm:af22:traffic-light:user%201");
  });

  it("lets line M open the board it creates: the workspace adds it to the list and opens its tab", () => {
    has(editor, "onBoardCreated?: (board: TPpmCanvasBoard) => void;");
    has(workspace, "onBoardCreated={(board) => { upsertBoard(board); openBoard(board.board_id); }}");
  });
});

describe("AF2.2 F2: глубокая ссылка ?board=…&shape=… («На карте» в задаче)", () => {
  it("builds the Canvas link of a card and reads it back on that board only", () => {
    const path = canvasShapeLinkPath("lab", "p-1", "b-1", "shape:abc");
    expect(path).toBe("/lab/projects/p-1/brain?board=b-1&shape=shape%3Aabc");
    const search = path.slice(path.indexOf("?"));
    expect(takeCanvasShapeLink(search, "b-1")).toEqual({ search: "?board=b-1", shapeId: "shape:abc" });
    expect(takeCanvasShapeLink(search, "b-2")).toBeUndefined();
    expect(takeCanvasShapeLink("?board=b-1", "b-1")).toBeUndefined();
    expect(takeCanvasShapeLink("?board=b-1&shape=", "b-1")).toBeUndefined();
    // Other parameters stay; a bare id gets tldraw's prefix; the rewritten address has nothing left to take.
    const taken = takeCanvasShapeLink("?board=b-1&shape=xyz&tab=2", "b-1");
    expect(taken).toEqual({ search: "?board=b-1&tab=2", shapeId: "shape:xyz" });
    expect(takeCanvasShapeLink(taken?.search ?? "", "b-1")).toBeUndefined();
  });

  it("selects the card and centres the camera on it without changing the zoom", () => {
    const found = fakeEditor({ "shape:abc": { h: 248, w: 360, x: 100, y: 40 } });
    expect(revealCanvasShape(found.editor, "shape:abc")).toBe(true);
    expect(found.calls).toEqual(["select shape:abc", "center 280,164 animated"]);
    const missing = fakeEditor({});
    expect(revealCanvasShape(missing.editor, "shape:gone")).toBe(false);
    expect(missing.calls).toEqual([]);
  });

  it("takes the link only in the active v2 tab after the board loaded; the workspace drops a stale one", () => {
    const at = editor.indexOf("takeCanvasShapeLink(window.location.search, boardId)");
    expect(at).toBeGreaterThan(-1);
    const effect = editor.slice(editor.lastIndexOf("useEffect(", at), editor.indexOf("]);", at) + 3);
    has(effect, "if (!editor || !grammarV2 || !isActive || !livingMapLoaded) return;");
    const take = effect.indexOf("replaceCanvasSearch(link.search)");
    expect(take).toBeGreaterThan(-1);
    expect(take).toBeLessThan(effect.indexOf("revealCanvasShape(editor, link.shapeId)"));
    has(effect, 'setContentNotice(ppmT("canvas.af22.shape_not_found"))');
    const deps = effect.slice(effect.lastIndexOf("}, ["));
    for (const dep of ["boardId", "grammarV2", "isActive", "livingMapLoaded"])
      expect(deps, dep).toMatch(new RegExp(`\\b${dep}\\b`));
    const sync = sliceBetween(
      workspace,
      'url.searchParams.set("board", activeBoardId);',
      'window.history.replaceState(window.history.state, "", url);'
    );
    // final-pass F2: одно имя параметра на всё приложение — PPM_CANVAS_SHAPE_PARAM (shape-link.ts), без литерала.
    expect(sync).toContain("url.searchParams.delete(PPM_CANVAS_SHAPE_PARAM);");
    expect(workspace).toContain('import { PPM_CANVAS_SHAPE_PARAM } from "./living-map/shape-link";');
    expect(workspace).not.toMatch(/searchParams\.(?:delete|get|has|set)\("shape"/);
  });
});

describe("AF2.2 финальная волна (FW-W): пункты final-pass F2", () => {
  it("gives every var(--ppm-…) in living-map.css a fallback, as the rest of the file does", () => {
    const uses = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/var\(\s*(--ppm-[\w-]+)\s*([,)])/g)];
    expect(uses.length).toBeGreaterThan(100);
    expect(uses.filter((match) => match[2] !== ",").map((match) => match[1])).toEqual([]);
  });

  it("notifies every subscriber (every open board tab) when «Светофор» is switched", () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = subscribeTrafficLight(first);
    const stopSecond = subscribeTrafficLight(second);
    writeTrafficLightPreference(memoryStorage(), "af22-user-e", false);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    stopFirst();
    writeTrafficLightPreference(throwingStorage(), "af22-user-e", true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    stopSecond();
  });

  it("reads «Светофор» from the browser storage once per page, a denied storage too", () => {
    const storage = memoryStorage({ [trafficLightStorageKey("af22-user-f")]: "off" });
    const getItem = vi.spyOn(storage, "getItem");
    expect(readTrafficLightPreference(storage, "af22-user-f")).toBe(false);
    expect(readTrafficLightPreference(storage, "af22-user-f")).toBe(false);
    expect(getItem).toHaveBeenCalledTimes(1);
    const denied = throwingStorage();
    const deniedGet = vi.spyOn(denied, "getItem");
    expect(readTrafficLightPreference(denied, "af22-user-g")).toBe(true);
    expect(readTrafficLightPreference(denied, "af22-user-g")).toBe(true);
    expect(deniedGet).toHaveBeenCalledTimes(1);
    // Запись по-прежнему сразу меняет значение страницы.
    writeTrafficLightPreference(storage, "af22-user-f", true);
    expect(readTrafficLightPreference(storage, "af22-user-f")).toBe(true);
    expect(getItem).toHaveBeenCalledTimes(1);
  });

  it("says in revealCanvasShape why it never switches the tldraw page: boards are single-page", () => {
    const link = read("living-map/shape-link.ts");
    const reveal = link.slice(link.indexOf("export function revealCanvasShape"));
    expect(link.slice(link.lastIndexOf("/**", link.indexOf("export function revealCanvasShape")))).toContain(
      "одностраничн"
    );
    expect(reveal).not.toContain("setCurrentPage");
  });
});
