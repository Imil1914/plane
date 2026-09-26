// AF2.2 C1: тексты ленты «Что изменилось» как в K5, даты, подписи объектов доски; кнопка и панель — классы колонки F,
// e.code, запись только по «Отметить просмотренным», фокус только после действия пользователя; строки блока C (en/ru).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPpmTranslation, PPM_TRANSLATIONS, type TPpmTranslationKey } from "@ppm/brand";
import {
  createPpmCanvasNode,
  createPpmMapSectionNode,
  createPpmSprintFrameNode,
  serializePpmCanvasNode,
  type TPpmCanvasBinding,
  type TPpmCanvasOwnedNodeKind,
} from "@ppm/canvas";
import {
  boardNodeLabelKey,
  describeBoardChange,
  formatChangesCount,
  formatChangesSince,
  formatChangeWhen,
  bindingTitle,
  nodeTitleForShapes,
  type TDescribeChangeContext,
} from "@/components/ppm-canvas/living-map/changes-format";
import type { TPpmBoardChange } from "@/services/ppm-canvas-changes.service";
import { PROJECT, pullRequestBinding, uuid, workItemBinding, WS } from "./fixtures/living-map";

const ME = "55555555-5555-4555-8555-555555555555";
const DASHA = "66666666-6666-4666-8666-666666666666";
const OLEG = "77777777-7777-4777-8777-000000000001";
const MISHA = "77777777-7777-4777-8777-000000000002";
const TASK_15 = "77777777-7777-4777-8777-777777777777";
const at = (day: number, hour = 12, minute = 0) => new Date(2026, 8, day, hour, minute).toISOString();
const NOW = new Date(2026, 8, 26, 12, 0).getTime();
const ru = (key: TPpmTranslationKey) => getPpmTranslation("ru", key);
const en = (key: TPpmTranslationKey) => getPpmTranslation("en", key);
const read = (name: string) =>
  readFileSync(new URL(`../../core/components/ppm-canvas/living-map/${name}`, import.meta.url), "utf8");
const buttonSource = read("changes-button.tsx");
const panelSource = read("changes-panel.tsx");
const css = read("living-map.css")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\s+/g, " ");

function change(overrides: Partial<TPpmBoardChange> & Pick<TPpmBoardChange, "id" | "kind">): TPpmBoardChange {
  return {
    actor: { id: DASHA, display_name: "Даша П." },
    detail: {},
    entity: { type: "work_item", id: TASK_15, identifier: "ROBOT-15", title: "Сценарий сортировки" },
    occurred_at: at(22),
    shape_ids: [],
    ...overrides,
  };
}

function context(overrides: Partial<TDescribeChangeContext> = {}): TDescribeChangeContext {
  return {
    currentUserId: ME,
    locale: "ru",
    nodeKindKey: () => undefined,
    nodeTitle: () => undefined,
    now: NOW,
    t: ru,
    ...overrides,
  };
}

describe("dates in the feed", () => {
  it("says «когда» in the words of the mockup", () => {
    expect(formatChangeWhen(new Date(NOW - 30_000).toISOString(), "ru", ru, NOW)).toBe("только что");
    expect(formatChangeWhen(new Date(NOW - 5 * 60_000).toISOString(), "ru", ru, NOW)).toBe("5 мин. назад");
    expect(formatChangeWhen(at(26, 9, 5), "ru", ru, NOW)).toBe("сегодня, 09:05");
    expect(formatChangeWhen(at(25, 18, 40), "ru", ru, NOW)).toBe("вчера, 18:40");
    expect(formatChangeWhen(at(22), "ru", ru, NOW)).toBe("22 сент.");
    expect(formatChangeWhen(new Date(2025, 11, 30).toISOString(), "ru", ru, NOW)).toBe("30 дек. 2025 г.");
    expect(formatChangeWhen(at(26, 9, 5), "en-US", en, NOW)).toBe("today, 09:05");
    expect(formatChangeWhen("not a date", "ru", ru, NOW)).toBe("—");
  });

  it("names the start of the period: a time today, a date otherwise; «200+» when the feed was cut", () => {
    expect(formatChangesSince(at(26, 11, 41), "ru", NOW)).toBe("11:41");
    expect(formatChangesSince(at(18), "ru", NOW)).toBe("18 сент.");
    expect(formatChangesSince(at(18), "en", NOW)).toBe("Sep 18");
    expect(formatChangesCount(6, false)).toBe("6");
    expect(formatChangesCount(200, true)).toBe("200+");
  });
});

describe("texts of the feed (K5)", () => {
  it("writes the K5 lines", () => {
    const state = change({
      id: "1",
      kind: "work_item.state",
      actor: { id: OLEG, display_name: "Олег С." },
      entity: { type: "work_item", id: "t16", identifier: "ROBOT-16" },
      detail: { field: "state", old: "Todo", new: "In Progress" },
    });
    expect(describeBoardChange(state, context())).toEqual({
      detail: "Олег С. · 22 сент.",
      icon: "state",
      text: "ROBOT-16 → В работе",
    });
    const relation = change({
      id: "2",
      kind: "work_item.relation",
      detail: { field: "blocked_by", old: null, new: "ROBOT-12" },
    });
    expect(describeBoardChange(relation, context())).toEqual({
      detail: "новая связь в Задачах · Даша П. · 22 сент.",
      icon: "relation",
      text: "ROBOT-12 блокирует ROBOT-15",
    });
    const version = change({
      id: "3",
      kind: "vault.version",
      occurred_at: at(20),
      actor: { id: MISHA, display_name: "Миша К." },
      entity: { type: "vault_file", id: "f", title: "Схема захвата.pdf" },
      detail: { field: "version", old: "2", new: "3" },
    });
    expect(describeBoardChange(version, context())).toEqual({
      detail: "новая версия · Миша К. · 20 сент.",
      icon: "file",
      text: "Схема захвата.pdf → v3",
    });
    const merged = change({
      id: "4",
      kind: "git.pull_request.merged",
      actor: null,
      occurred_at: at(19),
      entity: { type: "pull_request", id: "pr", identifier: "#46" },
      detail: { field: "work_items", new: "ROBOT-11" },
    });
    expect(describeBoardChange(merged, context())).toEqual({
      detail: "19 сент.",
      icon: "pr_merged",
      text: "PR #46 влит · ROBOT-11",
    });
  });

  it("names the other task changes in plain Russian", () => {
    const text = (kind: TPpmBoardChange["kind"], detail: TPpmBoardChange["detail"]) =>
      describeBoardChange(change({ id: "x", kind, detail }), context()).text;
    expect(text("work_item.assignees", { old: null, new: "Олег С." })).toBe("ROBOT-15: новый исполнитель — Олег С.");
    expect(text("work_item.assignees", { old: "Миша К.", new: null })).toBe("ROBOT-15: снят исполнитель — Миша К.");
    expect(text("work_item.due", { field: "due_date", new: "2026-09-29" })).toBe("ROBOT-15: срок → 29 сент.");
    expect(text("work_item.due", { field: "due_date", old: "2026-09-29", new: null })).toBe("ROBOT-15: срок снят");
    expect(text("work_item.priority", { new: "urgent" })).toBe("ROBOT-15: приоритет → Срочный");
    expect(text("work_item.name", { new: "Сценарий сортировки по цвету" })).toBe(
      "ROBOT-15: название → «Сценарий сортировки по цвету»"
    );
    expect(text("work_item.relation", { field: "relates_to", new: "ROBOT-7" })).toBe("ROBOT-15 связана с ROBOT-7");
    expect(text("work_item.relation", { field: "start_before", new: "ROBOT-7" })).toBe(
      "Зависимость: ROBOT-15 → ROBOT-7"
    );
    expect(text("work_item.relation", { field: "constructor", new: "ROBOT-7" })).toBe("Связь: ROBOT-15 — ROBOT-7");
    expect(text("work_item.state", { new: "Ревью у заказчика" })).toBe("ROBOT-15 → Ревью у заказчика");
    const pullRequest = change({
      id: "pr",
      kind: "git.pull_request.opened",
      entity: { type: "pull_request", id: "p" },
    });
    expect(describeBoardChange(pullRequest, context()).text).toBe("PR — открыт");
  });

  it("tells a removed relation in the past tense: «Связь удалена: ROBOT-12 блокировал ROBOT-15»", () => {
    const removed = change({
      id: "r",
      kind: "work_item.relation",
      detail: { field: "blocked_by", old: "ROBOT-12", new: null },
    });
    expect(describeBoardChange(removed, context())).toEqual({
      detail: "в Задачах · Даша П. · 22 сент.",
      icon: "relation",
      text: "Связь удалена: ROBOT-12 блокировал ROBOT-15",
    });
    expect(describeBoardChange(removed, context({ locale: "en", t: en })).text).toBe(
      "Link removed: ROBOT-12 was blocking ROBOT-15"
    );
    const text = (field: string) =>
      describeBoardChange(change({ id: "x", kind: "work_item.relation", detail: { field, old: "ROBOT-7" } }), context())
        .text;
    expect(text("blocking")).toBe("Связь удалена: ROBOT-15 блокировал ROBOT-7");
    expect(text("finish_after")).toBe("Зависимость удалена: ROBOT-15 → ROBOT-7");
    expect(text("relates_to")).toBe("Связь удалена: ROBOT-15 — ROBOT-7");
  });

  it("says «связь со скрытой задачей» when S2 hides the other task (old and new are null)", () => {
    const hidden = change({
      id: "h",
      kind: "work_item.relation",
      detail: { field: "relates_to", old: null, new: null },
    });
    expect(describeBoardChange(hidden, context())).toEqual({
      detail: "связь изменена в Задачах · Даша П. · 22 сент.",
      icon: "relation",
      text: "ROBOT-15: связь со скрытой задачей",
    });
  });

  it("says who: «Вы» for me, «на доске» for board objects without an author, nothing for system changes", () => {
    const mine = change({
      id: "m",
      kind: "work_item.state",
      actor: { id: ME, display_name: "Анна Л." },
      detail: { new: "Done" },
    });
    expect(describeBoardChange(mine, context()).detail).toBe("Вы · 22 сент.");
    const sticker = change({
      id: "s",
      kind: "board.node.added",
      actor: null,
      occurred_at: at(26, 9, 5),
      entity: { type: "node", id: "shape:s" },
      shape_ids: ["shape:s"],
      detail: { field: "shape_type", new: "note" },
    });
    expect(describeBoardChange(sticker, context({ nodeKindKey: () => "canvas.rail.sticky" }))).toEqual({
      detail: "добавлено · на доске · сегодня, 09:05",
      icon: "added",
      text: "Стикер",
    });
    const note = change({
      id: "n",
      kind: "board.node.changed",
      actor: null,
      entity: { type: "node", id: "shape:n", title: "Калибровка" },
      detail: { field: "kind", new: "note" },
    });
    expect(describeBoardChange(note, context({ nodeKindKey: () => "canvas.kind_note" }))).toEqual({
      detail: "изменено · на доске · 22 сент.",
      icon: "changed",
      text: "Заметка «Калибровка»",
    });
    const system = change({ id: "sys", kind: "work_item.state", actor: null, detail: { new: "Done" } });
    expect(describeBoardChange(system, context()).detail).toBe("22 сент.");
  });

  it("names a board object by its shape, or by the event when the shape has left the board", () => {
    const node = (kind: TPpmCanvasOwnedNodeKind) => ({
      type: "ppm-canvas-node",
      props: { node: serializePpmCanvasNode(createPpmCanvasNode({ authorId: ME, kind, title: "x" })) },
    });
    expect(boardNodeLabelKey(node("note"))).toBe("canvas.kind_note");
    expect(boardNodeLabelKey(node("group"))).toBe("canvas.kind_section");
    expect(boardNodeLabelKey({ type: "note", props: {} })).toBe("canvas.rail.sticky");
    expect(boardNodeLabelKey({ type: "geo", props: { geo: "ellipse" } })).toBe("canvas.shape.ellipse");
    expect(boardNodeLabelKey({ type: "ppm-canvas-node", props: { node: "{" } })).toBe("canvas.rail.object");
    const gone = (detail: TPpmBoardChange["detail"]) =>
      describeBoardChange(
        change({ id: "g", kind: "board.node.added", entity: { type: "node", id: "shape:g" }, detail }),
        context()
      ).text;
    expect(gone({ field: "kind", new: "note" })).toBe("Заметка");
    expect(gone({ field: "kind", new: "work_item_ref" })).toBe("Задача");
    expect(gone({ field: "shape_type", new: "text" })).toBe("Текст");
    expect(gone({ field: "shape_type", new: "geo" })).toBe("Объект");
  });

  // L-1 (живая проверка): у живой карточки нет своего заголовка — сервер отдаёт entity.title из node.title, и лента
  // писала «Задача, Задача, Задача». Теперь — по привязке фигуры, как подписывает сама карточка.
  const task228 = (() => {
    const binding = workItemBinding(4, "shape:task");
    return {
      ...binding,
      source: {
        ...binding.source,
        display: { ...binding.source.display, title: "3. Create and assign Work Items" },
        identity: { ...binding.source.identity, identifier: "228-4" },
      },
    };
  })();
  const content = (entityType: "page" | "vault_file", shapeId: string, title: string): TPpmCanvasBinding => ({
    binding_id: uuid(61_000 + shapeId.length),
    binding_status: "active",
    entity_id: uuid(62_000 + shapeId.length),
    entity_type: entityType,
    shape_id: shapeId,
    source: {
      capabilities: { delete_source: false, read: true, update: false },
      display: {
        excerpt: null,
        extension: entityType === "page" ? null : ".pdf",
        mime_type: entityType === "page" ? "text/html" : "application/pdf",
        preview_url: null,
        size_bytes: 2048,
        source_status: "active",
        title,
      },
      identity: {
        entity_id: uuid(62_000 + shapeId.length),
        entity_type: entityType,
        project_id: PROJECT,
        source_url: null,
        workspace_id: WS,
      },
      source_version: "3",
    },
    source_version: "3",
  });
  const bindings = new Map<string, TPpmCanvasBinding>([
    ["shape:task", task228],
    ["shape:file", content("vault_file", "shape:file", "Схема захвата.pdf")],
    ["shape:doc", content("page", "shape:doc", "Регламент испытаний")],
    ["shape:pr", pullRequestBinding(46, "shape:pr")],
  ]);
  const liveKinds: Record<string, TPpmTranslationKey> = {
    "shape:doc": "canvas.rail.page",
    "shape:file": "canvas.rail.file",
    "shape:pr": "canvas.rail.git",
    "shape:task": "canvas.rail.work_item",
  };
  const onBoard = context({
    nodeKindKey: (shapeIds) => liveKinds[shapeIds[0]],
    nodeTitle: (shapeIds) => nodeTitleForShapes(bindings, shapeIds),
  });
  const liveCard = (shapeId: string, extra: Partial<TPpmBoardChange> = {}) =>
    change({
      id: `node:${shapeId}`,
      kind: "board.node.added",
      actor: { id: ME, display_name: "Анна Л." },
      entity: { type: "node", id: shapeId },
      shape_ids: [shapeId],
      detail: { field: "kind", new: "work_item_ref" },
      ...extra,
    });

  it("names a live card by its binding: a task as «ID · title», a Vault file by its name (L-1)", () => {
    expect(describeBoardChange(liveCard("shape:task"), onBoard)).toEqual({
      detail: "добавлено · Вы · 22 сент.",
      icon: "added",
      text: "Задача «228-4 · 3. Create and assign Work Items»",
    });
    expect(describeBoardChange(liveCard("shape:file", { kind: "board.node.changed" }), onBoard).text).toBe(
      "Файл «Схема захвата.pdf»"
    );
    // Git-объект — коротко (ревью FW-W): номер «#46» и название; документ — название.
    expect(describeBoardChange(liveCard("shape:pr"), onBoard).text).toBe("Git-объект «#46 · PR 46»");
    expect(describeBoardChange(liveCard("shape:doc"), onBoard).text).toBe("Документ PPM «Регламент испытаний»");
    // Заголовок привязки важнее entity.title сервера (у живой карточки это node.title — пусто или устаревшее).
    expect(
      describeBoardChange(
        liveCard("shape:task", { entity: { type: "node", id: "shape:task", title: "старое" } }),
        onBoard
      ).text
    ).toBe("Задача «228-4 · 3. Create and assign Work Items»");
    // Английский интерфейс — те же данные привязки в формате node_titled.
    expect(
      describeBoardChange(
        liveCard("shape:task"),
        context({
          locale: "en",
          nodeKindKey: () => "canvas.rail.work_item",
          nodeTitle: (shapeIds) => nodeTitleForShapes(bindings, shapeIds),
          t: en,
        })
      ).text
    ).toBe("Task “228-4 · 3. Create and assign Work Items”");
    // Задача без идентификатора (нет проекта в проекции) — только название.
    const bare = {
      ...task228,
      source: { ...task228.source, identity: { ...task228.source.identity, identifier: null } },
    };
    expect(nodeTitleForShapes(new Map([["shape:task", bare]]), ["shape:task"])).toBe("3. Create and assign Work Items");
  });

  it("labels a Git card shortly: «#46 · title» for a PR, 7 hash characters for a commit, the ref for a branch", () => {
    const git = (display: Partial<ReturnType<typeof pullRequestBinding>["source"]["display"]>) => {
      const binding = pullRequestBinding(46, "shape:git");
      return { ...binding, source: { ...binding.source, display: { ...binding.source.display, ...display } } };
    };
    // GitHub отдаёт номер PR без «#» («46», providers/github.py) — в ленте «#46», как в лотке.
    expect(bindingTitle(git({ ref: "46", title: "Захват по цвету" }))).toBe("#46 · Захват по цвету");
    expect(bindingTitle(git({ ref: "#46", title: "Захват по цвету" }))).toBe("#46 · Захват по цвету");
    expect(bindingTitle(git({ ref: "feature/grip", title: "" }))).toBe("feature/grip");
    expect(
      bindingTitle(
        git({ commit_sha: "9f1c2ab7de40", object_type: "commit", ref: "9f1c2ab7de40", title: "Fix gripper limits" })
      )
    ).toBe("9f1c2ab · Fix gripper limits");
    expect(bindingTitle(git({ object_type: "branch", ref: "main", title: "main" }))).toBe("main");
    expect(bindingTitle(git({ object_type: "repository", ref: "", title: "robot" }))).toBe("robot");
    // Подпись без слов интерфейса — одинакова в ru и en (вид называет строка ленты).
    expect(bindingTitle(git({ ref: "46", title: "Colour grip" }))).toBe("#46 · Colour grip");
  });

  it("falls back to the server title, then to the kind alone, for a shape without a binding (L-1)", () => {
    // Своя карточка PPM или нативная фигура — привязки нет: заголовок сервера, как раньше.
    const note = liveCard("shape:note", {
      entity: { type: "node", id: "shape:note", title: "Калибровка" },
      detail: { field: "kind", new: "note" },
    });
    expect(
      describeBoardChange(note, context({ nodeKindKey: () => "canvas.kind_note", nodeTitle: () => undefined })).text
    ).toBe("Заметка «Калибровка»");
    expect(nodeTitleForShapes(bindings, ["shape:note"])).toBeUndefined();
    // Живая карточка, чья привязка ещё не пришла, без заголовка сервера — только вид.
    const pending = liveCard("shape:new");
    expect(
      describeBoardChange(
        pending,
        context({
          nodeKindKey: () => "canvas.rail.work_item",
          nodeTitle: (ids) => nodeTitleForShapes(bindings, ids),
        })
      ).text
    ).toBe("Задача");
  });

  it("names a card that has left the board by the event: the server title or the kind alone (L-1)", () => {
    // Фигуры нет на доске (nodeKindKey → undefined), её привязка уже снята опросом — вид из события.
    const removed = liveCard("shape:gone", { kind: "board.node.changed" });
    const gone = context({ nodeKindKey: () => undefined, nodeTitle: (ids) => nodeTitleForShapes(bindings, ids) });
    expect(describeBoardChange(removed, gone).text).toBe("Задача");
    expect(
      describeBoardChange(
        liveCard("shape:gone", { entity: { type: "node", id: "shape:gone", title: "Прототип захвата" } }),
        gone
      ).text
    ).toBe("Задача «Прототип захвата»");
    // Фигуры нет, а привязка ещё в карте доски (до ближайшего опроса) — подпись по привязке, данные те же.
    expect(describeBoardChange(liveCard("shape:task"), gone).text).toBe(
      "Задача «228-4 · 3. Create and assign Work Items»"
    );
  });

  it("calls the sprint frame «Рамка спринта» and a map section «Секция» (L-2)", () => {
    const frame = serializePpmCanvasNode(
      createPpmSprintFrameNode({ authorId: ME, cycleId: TASK_15, now: at(20), title: "Cycle 1: Getting Started" })
    );
    const mapSection = serializePpmCanvasNode(
      createPpmMapSectionNode({ authorId: ME, moduleId: null, now: at(20), title: "Core Workflow (System)" })
    );
    expect(boardNodeLabelKey({ type: "ppm-canvas-node", props: { node: frame } })).toBe(
      "canvas.changes.kind_sprint_frame"
    );
    expect(boardNodeLabelKey({ type: "ppm-canvas-node", props: { node: mapSection } })).toBe("canvas.kind_section");
    const added = change({
      id: "frame",
      kind: "board.node.added",
      actor: null,
      entity: { type: "node", id: "shape:frame", title: "Cycle 1: Getting Started" },
      shape_ids: ["shape:frame"],
      detail: { field: "kind", new: "group" },
    });
    const frameContext = (t: typeof ru) =>
      context({
        nodeKindKey: () => boardNodeLabelKey({ type: "ppm-canvas-node", props: { node: frame } }),
        t,
      });
    expect(describeBoardChange(added, frameContext(ru)).text).toBe("Рамка спринта «Cycle 1: Getting Started»");
    expect(describeBoardChange(added, frameContext(en)).text).toBe("Sprint frame “Cycle 1: Getting Started”");
  });
});

describe("button and panel (K5)", () => {
  it("closes by Escape through e.code and writes the checkpoint only from its button", () => {
    expect(panelSource).toContain('if (event.code !== "Escape") return;');
    expect(panelSource).not.toMatch(/event\.key\b/);
    // tldraw listens for keydown on .tl-container (an ancestor) and React gets events only at its root, after tldraw:
    // a native listener on the panel stops Escape before tldraw drops the selection (editor.cancel).
    expect(panelSource).toMatch(
      /if \(event\.code !== "Escape"\) return;\s*event\.stopPropagation\(\);\s*event\.preventDefault\(\);\s*setOpen\(false\);/
    );
    expect(panelSource).toContain('section.addEventListener("keydown", onKeyDown);');
    expect(panelSource).toContain('return () => section.removeEventListener("keydown", onKeyDown);');
    expect(panelSource).toContain("<section ref={sectionRef}");
    expect(panelSource).not.toContain("onKeyDown={");
    expect(panelSource).toMatch(/className="ppm-changes-panel__seen"[^>]*onClick=\{panel\.markSeen\}/);
    expect(panelSource).toContain("onClick={() => focusChangeShapes(editor, entry.shape_ids)}");
    expect(panelSource).not.toContain("canEdit");
    expect(buttonSource).not.toContain("canEdit");
  });

  it("titles live cards by the board's bindings from the living map context (L-1)", () => {
    expect(panelSource).toContain("const { args, changes } = usePpmLivingMap();");
    expect(panelSource).toContain("nodeTitle: (shapeIds) => nodeTitleForShapes(args.bindingsByShapeId, shapeIds),");
  });

  it("wears the column's pill and panel (F) and is memoized: CanvasControls re-renders on every drag frame", () => {
    expect(buttonSource).toContain("export const PpmChangesButton = memo(function PpmChangesButton() {");
    expect(panelSource).toContain("export const PpmChangesPanel = memo(function PpmChangesPanel() {");
    expect(buttonSource).toContain('className="ppm-living-map-pill ppm-changes-button"');
    expect(panelSource).toContain('className="ppm-living-map-panel ppm-changes-panel"');
  });

  it("hides the inspector while the panel is open (one right panel) and scrolls a long feed inside the panel", () => {
    expect(css).toContain(
      ':where(html[data-ppm-design="v2"]) [data-ppm-canvas-grammar="v2"] .tl-container:has(.ppm-changes-panel) ~ .ppm-canvas-inspector { display: none; }'
    );
    expect(css).toMatch(/\.ppm-changes-panel__list \{[^}]*max-height: 18rem;[^}]*overflow-y: auto;/);
  });

  it("hides the button while the panel is open or the feed is unavailable; focus moves only after a click", () => {
    expect(buttonSource).toContain(
      'const visible = Boolean(grammarV2 && panel && !panel.open && panel.status !== "unavailable");'
    );
    expect(buttonSource).toContain('if (visible && panel?.consumeFocus("button")) buttonRef.current?.focus();');
    expect(panelSource).toContain('if (open && panel?.consumeFocus("panel")) closeRef.current?.focus();');
  });

  it("names itself with a real heading and shows the date the feed really uses when the field is left", () => {
    expect(panelSource).toContain('<h2 id={titleId} className="ppm-changes-panel__title">');
    expect(panelSource).toContain("aria-labelledby={titleId}");
    expect(css).toMatch(/\.ppm-changes-panel__title \{[^}]*margin: 0;[^}]*font-size: inherit;/);
    expect(panelSource).toContain(
      "onBlur={(event) => panel.setCustomDate(clampChangesDate(event.currentTarget.value, Date.now()))}"
    );
    expect(panelSource).toContain("onChange={(event) => panel.setMode(event.currentTarget.value as TChangesMode)}");
  });
});

describe("strings of block C (af22-living-map.ts)", () => {
  const keys = (locale: "en" | "ru") =>
    new Set(Object.keys(PPM_TRANSLATIONS[locale]).filter((key) => key.startsWith("canvas.changes.")));

  it("keeps en and ru in parity", () => {
    expect(keys("ru")).toEqual(keys("en"));
    // 51 from the plan + 7 for removed relations in the past tense (fix round 1) + «Рамка спринта» (L-2).
    expect(keys("ru").size).toBe(59);
    expect(ru("canvas.changes.kind_sprint_frame")).toBe("Рамка спринта");
    expect(en("canvas.changes.kind_sprint_frame")).toBe("Sprint frame");
  });

  it("uses the K5 wording", () => {
    expect(ru("canvas.changes.mark_seen")).toBe("Отметить просмотренным");
    expect(ru("canvas.changes.chip_changed")).toBe("изменено");
    expect(ru("canvas.changes.chip_added")).toBe("добавлено");
    expect(ru("canvas.changes.mode_sprint")).toBe("с начала спринта");
  });
});
