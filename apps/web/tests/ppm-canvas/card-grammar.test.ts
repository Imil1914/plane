import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPpmTranslation } from "@ppm/brand";
import {
  fillCanvasTemplate,
  LIVE_SOURCE_LABEL_KEYS,
  LIVE_SOURCE_OPEN_KEYS,
  liveCardMeta,
  liveSourceForEntity,
  nodeIndicatorRadius,
  OWN_NODE_KIND_KEYS,
  sectionObjectCountKey,
  shouldNarrowTitle,
} from "@/components/ppm-canvas/canvas-grammar";

const source = (file: string) =>
  readFileSync(new URL(`../../core/components/ppm-canvas/${file}`, import.meta.url), "utf8");
const shapeSource = source("shape.tsx");
const liveCardSource = source("live-card.tsx");
const isExternalLiveOpenLinkCall = (call: string) => /^\s*<LiveOpenLink\s+external\b/.test(call);

describe("live card grammar (UX1.1 C3)", () => {
  it("maps every projection to its PPM section", () => {
    expect(["work_item", "attachment"].map((type) => liveSourceForEntity(type as "work_item"))).toEqual([
      "tasks",
      "tasks",
    ]);
    expect(liveSourceForEntity("vault_file")).toBe("knowledge");
    expect(liveSourceForEntity("page")).toBe("pages");
    expect(
      ["repository", "branch", "commit", "pull_request"].map((type) => liveSourceForEntity(type as "commit"))
    ).toEqual(["code", "code", "code", "code"]);
    expect(getPpmTranslation("ru", LIVE_SOURCE_LABEL_KEYS.tasks)).toBe("Задачи");
    expect(getPpmTranslation("ru", LIVE_SOURCE_LABEL_KEYS.knowledge)).toBe("Хранилище");
  });

  it("names the open link after the object and the section", () => {
    expect(getPpmTranslation("ru", LIVE_SOURCE_OPEN_KEYS.tasks).replace("{name}", "ROBOT-12")).toBe(
      "Открыть ROBOT-12 в Задачах"
    );
    expect(getPpmTranslation("ru", LIVE_SOURCE_OPEN_KEYS.knowledge).replace("{name}", "«Схема захвата.pdf»")).toBe(
      "Открыть «Схема захвата.pdf» в Хранилище"
    );
    expect(getPpmTranslation("ru", "canvas.live_card")).toBe("Живая карточка");
    for (const key of Object.values(LIVE_SOURCE_OPEN_KEYS))
      expect(getPpmTranslation("ru", key)).not.toMatch(/Vault|Page/);
  });

  it("narrows long titles before clamping", () => {
    expect(shouldNarrowTitle("Откалибровать датчик цвета", 360)).toBe(false);
    expect(
      shouldNarrowTitle(
        "Откалибровать датчик цвета на стенде и записать поправки для всех четырёх режимов освещения",
        360
      )
    ).toBe(true);
  });

  it("keeps the selection outline in sync with the card radius", () => {
    expect(nodeIndicatorRadius(false, "note")).toBe(12);
    expect(nodeIndicatorRadius(true, "work_item_ref")).toBe(8);
    expect(nodeIndicatorRadius(true, "group")).toBe(0);
    expect(nodeIndicatorRadius(true, "frame")).toBe(0);
  });

  it("keeps the e2e anchors of the work item card", () => {
    expect(shapeSource).toContain('className="ppm-work-item-card');
    expect(shapeSource).toContain('aria-label={ppmT("canvas.work_item_state")}');
    expect(shapeSource).toMatch(/aria-label=\{grammarV2 \? ppmT\("canvas\.remove_projection"\) : undefined\}/);
  });

  it("opens external Git links in a new tab but keeps internal PPM links same-tab", () => {
    expect(liveCardSource).toMatch(/rel=\{external \? "noreferrer" : undefined\}/);
    expect(liveCardSource).toMatch(/target=\{external \? "_blank" : undefined\}/);
    // Only the Git card's provider URL leaves PPM; task/vault-file/page links stay in the app (v1 parity).
    const openLinkCalls = shapeSource.match(/<LiveOpenLink\b[\s\S]*?\/>/g) ?? [];
    expect(openLinkCalls).toHaveLength(4);
    expect(openLinkCalls.filter(isExternalLiveOpenLinkCall)).toHaveLength(1);
    expect(openLinkCalls.find(isExternalLiveOpenLinkCall)).toMatch(/href=\{sourceUrl\}/);
  });
});

describe("own cards and sections (UX1.1 C4)", () => {
  it("labels own cards in sentence case by kind", () => {
    expect(getPpmTranslation("ru", OWN_NODE_KIND_KEYS.note)).toBe("Заметка");
    expect(getPpmTranslation("ru", OWN_NODE_KIND_KEYS.group)).toBe("Секция");
    // Order-free comparison without Array#sort (ES2022 lib has no toSorted; unicorn/no-array-sort).
    expect(new Set(Object.keys(OWN_NODE_KIND_KEYS))).toEqual(
      new Set([
        "board_link",
        "checklist",
        "code",
        "deck",
        "diagram",
        "document",
        "frame",
        "group",
        "note",
        "table",
        "work_items_view",
      ])
    );
    expect(Object.keys(OWN_NODE_KIND_KEYS)).toHaveLength(11);
  });

  it("counts section objects with Russian and English plurals", () => {
    const ru = (count: number) =>
      getPpmTranslation("ru", sectionObjectCountKey(count, "ru")).replace("{count}", String(count));
    expect([ru(1), ru(3), ru(7), ru(11), ru(21), ru(0)]).toEqual([
      "1 объект",
      "3 объекта",
      "7 объектов",
      "11 объектов",
      "21 объект",
      "0 объектов",
    ]);
    const en = (count: number) =>
      getPpmTranslation("en", sectionObjectCountKey(count, "en")).replace("{count}", String(count));
    expect([en(1), en(21)]).toEqual(["1 object", "21 objects"]);
  });

  it("picks plural forms by the UI language, not by the raw locale (ru* → ru, else en)", () => {
    expect(sectionObjectCountKey(21, "ru-RU")).toBe("canvas.section_objects_one");
    expect(sectionObjectCountKey(3, "ru-RU")).toBe("canvas.section_objects_few");
    // Ukrainian has a "few" form of its own; the canvas speaks English there, so it must not borrow it.
    expect(sectionObjectCountKey(3, "uk")).toBe("canvas.section_objects_many");
    expect(sectionObjectCountKey(1, "de")).toBe("canvas.section_objects_one");
  });

  it("keeps the note title textbox name for e2e", () => {
    expect(shapeSource).toContain("aria-label={ppmT(NATIVE_NODE_LABELS[node.kind])}");
  });
});

describe("safe templates (UX1.1 final fixes B3)", () => {
  it("substitutes user text literally, even with $-patterns", () => {
    const open = getPpmTranslation("ru", LIVE_SOURCE_OPEN_KEYS.tasks);
    // String#replace with a string replacement expands $& / $' / $$ — the bug this helper removes.
    expect(open.replace("{name}", "Бюджет $& план")).toBe("Открыть Бюджет {name} план в Задачах");
    expect(fillCanvasTemplate(open, { name: "Бюджет $& план" })).toBe("Открыть Бюджет $& план в Задачах");
    expect(fillCanvasTemplate("{a}|{b}", { a: "$'", b: "$$ $1 $<x>" })).toBe("$'|$$ $1 $<x>");
    expect(fillCanvasTemplate("{index}: {text}", { index: 2, text: "{index}" })).toBe("2: {index}");
    expect(fillCanvasTemplate("{known} {unknown}", { known: "x" })).toBe("x {unknown}");
  });

  it("is used for every UX1.1 template on the canvas", () => {
    for (const file of ["shape.tsx", "canvas-inspector.tsx", "live-card.tsx"])
      expect(source(file), file).not.toMatch(/\.replace\("\{/);
    // workspace.tsx: the status line and the zoom label are UX1.1; only the wave 0 archive dialog keeps .replace.
    expect(source("workspace.tsx").match(/\.replace\("\{\w+\}"/g)).toEqual(['.replace("{name}"']);
    expect(source("workspace.tsx")).toContain('ppmT("canvas.archive_board_description").replace("{name}", board.name)');
  });
});

describe("live card meta line (UX1.1 final fixes B10)", () => {
  it("hides an empty version instead of printing «v—»", () => {
    expect(liveCardMeta(".pdf", "3")).toBe("PDF · v3");
    expect(liveCardMeta(".pdf", null)).toBe("PDF");
    expect(liveCardMeta(null, "")).toBe("");
    expect(liveCardMeta(null, " 7 ")).toBe("v7");
    expect(shapeSource).not.toContain('`v${binding.source_version ?? "—"}`');
  });
});

describe("state names on the live card (UX1.1 final fixes B4, R11)", () => {
  it("shows default states in the UI language only in grammar v2, keeping the option values", () => {
    expect(shapeSource).toContain(
      "{grammarV2 ? (getPpmStateDisplayName(state, currentLocale) ?? state.name) : state.name}"
    );
    expect(shapeSource).toContain("<option key={state.id} value={state.id}>");
  });
});
