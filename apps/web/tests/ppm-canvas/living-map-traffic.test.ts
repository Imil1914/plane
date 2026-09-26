// AF2.2 M3: «Светофор» — готова / заблокирована / просрочена по правилам спецификации (C), факты задач доски, счётчики
// в шапках секций; рамка и строка на живой карточке только под v2 и при включённом переключателе.
import { readFileSync } from "node:fs";
import { makeObservable, observable, runInAction } from "mobx";
import { computedFn } from "mobx-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPpmTranslation } from "@ppm/brand";
import { createPpmMapSectionNode, serializePpmCanvasNode } from "@ppm/canvas";
import { fillCanvasTemplate } from "@/components/ppm-canvas/canvas-grammar";
import {
  cacheProjectIssues,
  computeLivingMapView,
  EMPTY_LIVING_MAP_DATA,
  loadLivingMapData,
  PROJECT_ISSUES_TTL_MS,
  watchProjectIdentifier,
} from "@/components/ppm-canvas/living-map/map-data";
import { mapGroupsOf } from "@/components/ppm-canvas/living-map/map-model";
import { computeWorkItemFacts, trafficOf } from "@/components/ppm-canvas/living-map/traffic-light";
import { PpmTrafficLightToggle } from "@/components/ppm-canvas/living-map/traffic-light-toggle";
import {
  CURRENT,
  issue,
  MECH,
  MODULES,
  norm,
  NOW,
  OTHER_PROJECT,
  PROJECT,
  relation,
  STATE,
  STATES,
  USER,
  uuid,
  workItemBinding,
} from "./fixtures/living-map";

const TODAY = "2026-09-26";
const dir = new URL("../../core/components/ppm-canvas/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
const has = (source: string, needle: string) => expect(norm(source), needle).toContain(norm(needle));
const blocker = (seq: number, stateGroup: string | null) => ({ id: uuid(seq), identifier: `ROBOT-${seq}`, stateGroup });

function functionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("AF2.2 M3: правила «Светофора»", () => {
  it("marks an unfinished task overdue from the day after its due date, by the local calendar", () => {
    expect(trafficOf({ blockers: [], dueDate: "2026-09-25", stateGroup: "started" }, TODAY)).toEqual({
      blockedBy: [],
      dueDate: "2026-09-25",
      traffic: "overdue",
    });
    expect(trafficOf({ blockers: [], dueDate: "2026-09-26", stateGroup: "started" }, TODAY).traffic).toBe("none");
    expect(trafficOf({ blockers: [], dueDate: "2026-09-25T00:00:00Z", stateGroup: "backlog" }, TODAY)).toMatchObject({
      dueDate: "2026-09-25",
      traffic: "overdue",
    });
    expect(trafficOf({ blockers: [], dueDate: null, stateGroup: "started" }, TODAY).traffic).toBe("none");
  });

  it("puts «blocked» above «overdue» while a blocker is unfinished (unknown states count as unfinished)", () => {
    expect(
      trafficOf({ blockers: [blocker(12, "started")], dueDate: "2026-09-20", stateGroup: "started" }, TODAY)
    ).toEqual({
      blockedBy: [{ id: uuid(12), identifier: "ROBOT-12" }],
      dueDate: "2026-09-20",
      traffic: "blocked",
    });
    expect(
      trafficOf({ blockers: [blocker(12, "completed")], dueDate: "2026-09-20", stateGroup: "started" }, TODAY).traffic
    ).toBe("overdue");
    expect(
      trafficOf({ blockers: [blocker(12, "cancelled")], dueDate: null, stateGroup: "started" }, TODAY).traffic
    ).toBe("none");
    expect(trafficOf({ blockers: [blocker(3, null)], dueDate: null, stateGroup: "started" }, TODAY).traffic).toBe(
      "blocked"
    );
  });

  it("mutes a finished task above everything and leaves a cancelled one alone", () => {
    expect(
      trafficOf({ blockers: [blocker(12, "started")], dueDate: "2026-09-01", stateGroup: "completed" }, TODAY).traffic
    ).toBe("done");
    expect(
      trafficOf({ blockers: [blocker(12, "started")], dueDate: "2026-09-01", stateGroup: "cancelled" }, TODAY).traffic
    ).toBe("none");
  });
});

describe("AF2.2 M3: факты задач доски и счётчики секций", () => {
  it("builds the facts of every task on the board from its live card and the Plane links", () => {
    const cards = [
      { binding: workItemBinding(15, "shape:c15"), shapeId: "shape:c15" },
      { binding: workItemBinding(12, "shape:c12", { stateGroup: "completed" }), shapeId: "shape:c12" },
      { binding: workItemBinding(9, "shape:c9", { dueDate: "2026-09-20" }), shapeId: "shape:c9" },
      { binding: workItemBinding(7, "shape:c7"), shapeId: "shape:c7" },
      { binding: workItemBinding(5, "shape:c5", { dueDate: "2026-09-20" }), shapeId: "shape:c5" },
    ];
    const issues = new Map(
      [
        // ROBOT-12 в списке ещё «в работе», но его карточка на доске уже «Готово» — берётся карточка.
        issue(15, [], { issue_relation: [relation(12, "blocked_by", { state_id: STATE.started })] }),
        issue(9, [], { issue_relation: [relation(20, "blocked_by", { state_id: STATE.started })] }),
        issue(7, [], { issue_relation: [relation(3, "blocked_by", { project_id: OTHER_PROJECT, state_id: null })] }),
        issue(5, [], { issue_relation: [relation(16, "relates_to"), relation(16, "custom")] }),
      ].map((item) => [item.id, item])
    );
    const facts = computeWorkItemFacts({
      cards,
      issues,
      projectId: PROJECT,
      projectIdentifier: "ROBOT",
      states: STATES,
      today: new Date(2026, 8, 26, 0, 30),
    });
    // Итоговое ревью M-8: связей в фактах нет — слой связей берёт relationEdges (collectTaskRelations).
    expect(facts.get(uuid(15))).toEqual({
      blockedBy: [],
      dueDate: null,
      traffic: "none",
      workItemId: uuid(15),
    });
    expect(facts.get(uuid(12))).toMatchObject({ traffic: "done" });
    expect(facts.get(uuid(9))).toMatchObject({
      blockedBy: [{ id: uuid(20), identifier: "ROBOT-20" }],
      dueDate: "2026-09-20",
      traffic: "blocked",
    });
    expect(facts.get(uuid(7))).toMatchObject({ blockedBy: [{ id: uuid(3), identifier: "#3" }], traffic: "blocked" });
    expect(facts.get(uuid(5))).toEqual({
      blockedBy: [],
      dueDate: "2026-09-20",
      traffic: "overdue",
      workItemId: uuid(5),
    });
  });

  it("counts overdue and blocked tasks in the section header", () => {
    const section = serializePpmCanvasNode(
      createPpmMapSectionNode({ authorId: USER, moduleId: MECH, now: NOW, title: "Механика" })
    );
    const view = computeLivingMapView({
      cards: [
        { binding: workItemBinding(9, "shape:c9", { dueDate: "2026-09-20" }), shapeId: "shape:c9" },
        { binding: workItemBinding(5, "shape:c5", { dueDate: "2026-09-20" }), shapeId: "shape:c5" },
      ],
      data: {
        ...EMPTY_LIVING_MAP_DATA,
        issues: new Map([[uuid(9), issue(9, [], { issue_relation: [relation(20, "blocked_by")] })]]),
      },
      groups: mapGroupsOf([
        { id: "shape:mech", node: section, parentId: "page:page" },
        { id: "shape:c9", node: null, parentId: "shape:mech" },
        { id: "shape:c5", node: null, parentId: "shape:mech" },
      ]),
      options: { assignees: [], priorities: [], states: STATES },
      projectId: PROJECT,
      projectIdentifier: "ROBOT",
      today: new Date(2026, 8, 26),
    });
    expect(view.mapSections.get("shape:mech")).toEqual({ blocked: 1, done: 0, overdue: 1, role: "section", total: 2 });
  });
});

describe("AF2.2 M3: вид", () => {
  it("decorates the live task card only under v2 with the switch on, through its own blocks", () => {
    const shape = read("shape.tsx");
    const card = functionSource(shape, "WorkItemProjectionCard");
    expect(card.indexOf("const livingMap = usePpmLivingMap();")).toBeGreaterThan(-1);
    expect(card.indexOf("const livingMap = usePpmLivingMap();")).toBeLessThan(
      card.indexOf("if (!binding || binding.entity_type")
    );
    has(
      card,
      "const traffic = grammarV2 && livingMap.trafficLight ? livingMap.facts.get(binding.entity_id) : undefined;"
    );
    has(card, "data-ppm-traffic={trafficState}");
    has(card, "{traffic && trafficState && <PpmTrafficLine facts={traffic} />}");
    expect(card.indexOf("<PpmTrafficLine")).toBeLessThan(
      card.indexOf('{error && <p className="ppm-work-item-card__error">')
    );
    const toggle = read("living-map/traffic-light-toggle.tsx");
    has(toggle, "if (!args.enabled || facts.size === 0) return null;");
    has(toggle, 'role="switch"');
    has(toggle, "aria-checked={trafficLight}");
    has(toggle, "onClick={() => setTrafficLight(!trafficLight)}");
    expect(toggle).toContain("ppm-living-map-pill");
  });

  it("draws the frames with the warning and danger tokens and mutes finished cards without opacity", () => {
    const css = read("living-map/living-map.css");
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
    const rule = (selectorPart: string) => {
      const match = new RegExp(`${selectorPart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^{]*\\{([^}]*)\\}`).exec(flat);
      expect(match, selectorPart).not.toBeNull();
      return match?.[1] ?? "";
    };
    expect(rule('.ppm-live-card[data-ppm-traffic="blocked"])')).toContain("var(--ppm-color-danger-line");
    expect(rule('.ppm-live-card[data-ppm-traffic="overdue"])')).toContain("var(--ppm-color-warning");
    const done = rule('.ppm-live-card[data-ppm-traffic="done"])');
    expect(done).toContain("var(--ppm-color-surface-2");
    expect(done).not.toContain("opacity");
  });

  it("names «Светофор» and its lines in both languages", () => {
    expect(getPpmTranslation("ru", "canvas.traffic.toggle")).toBe("Светофор");
    expect(fillCanvasTemplate(getPpmTranslation("ru", "canvas.traffic.overdue_line"), { date: "20 сент." })).toBe(
      "просрочено · 20 сент."
    );
    expect(fillCanvasTemplate(getPpmTranslation("ru", "canvas.traffic.blocked_line"), { id: "ROBOT-12" })).toBe(
      "заблокирована ROBOT-12"
    );
    expect(getPpmTranslation("en", "canvas.traffic.toggle")).toBe("Traffic light");
  });
});

describe("AF2.2 финальная волна (FW-W)", () => {
  it("follows the project identifier in the non-observer editor: «заблокирована ROBOT-12» updates (final-pass M1)", () => {
    // Как project.store.ts: getProjectIdentifierById — computedFn над наблюдаемой projectMap.
    class ProjectStore {
      projectMap: Record<string, { identifier: string }> = {};
      constructor() {
        makeObservable(this, { projectMap: observable });
      }
      getProjectIdentifierById = computedFn((projectId: string) => this.projectMap?.[projectId]?.identifier);
    }
    const store = new ProjectStore();
    const seen: (string | null)[] = [];
    const stop = watchProjectIdentifier(
      () => store.getProjectIdentifierById(PROJECT),
      (identifier) => seen.push(identifier)
    );
    // Проект догрузился после редактора, затем его идентификатор сменили.
    runInAction(() => {
      store.projectMap[PROJECT] = { identifier: "ROBOT" };
    });
    runInAction(() => {
      store.projectMap[PROJECT] = { identifier: "ROBO" };
    });
    stop();
    runInAction(() => {
      store.projectMap[PROJECT] = { identifier: "LATE" };
    });
    expect(seen).toEqual([null, "ROBOT", "ROBO"]);
    // Редактор (не observer) держит идентификатор в состоянии и получает его от реакции, а не при отрисовке.
    const editor = read("editor.tsx");
    has(
      editor,
      "useEffect(() => watchProjectIdentifier(() => getProjectIdentifierById(projectId), setLivingMapProjectIdentifier), [getProjectIdentifierById, projectId]);"
    );
    expect(editor).not.toContain("const livingMapProjectIdentifier = getProjectIdentifierById(projectId) || null;");
    // Факты берут идентификатор из args: «заблокирована ROBOT-12» и номера в лотке — от него.
    const facts = computeWorkItemFacts({
      cards: [{ binding: workItemBinding(9, "shape:c9"), shapeId: "shape:c9" }],
      issues: new Map([[uuid(9), issue(9, [], { issue_relation: [relation(12, "blocked_by")] })]]),
      projectId: PROJECT,
      projectIdentifier: "ROBO",
      states: STATES,
      today: new Date(2026, 8, 26),
    });
    expect(facts.get(uuid(9))?.blockedBy).toEqual([{ id: uuid(12), identifier: "ROBO-12" }]);
  });

  it("keeps no dead data: facts without relations, no unused change-kind type (M-8)", () => {
    const types = read("living-map/living-map-types.ts");
    expect(types).not.toMatch(/\brelations\??:/);
    expect(types).not.toContain("TWorkItemRelation");
    expect(read("living-map/traffic-light.ts")).not.toContain("PLANE_RELATION_TYPES");
    const service = readFileSync(new URL("../../core/services/ppm-canvas-changes.service.ts", import.meta.url), "utf8");
    expect(service).not.toContain("TPpmBoardChangeKind");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the project's task list at most once per 5 minutes per board; the sprint's tasks every time (M-3)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T09:00:00Z"));
    expect(PROJECT_ISSUES_TTL_MS).toBe(5 * 60_000);
    // Карточка 30 — вне спринта карты (из проектного списка), 31 — положена позже, в запомненном списке её нет.
    const projectIssues = vi.fn(async () => [
      issue(30, [], { cycle_id: null, issue_relation: [relation(12, "blocked_by")] }),
    ]);
    const sprintIssues = vi.fn(async () => [issue(5)]);
    const loaders = {
      cycle: vi.fn(async () => CURRENT),
      modules: vi.fn(async () => MODULES),
      projectIssues: cacheProjectIssues(projectIssues),
      pullRequests: vi.fn(async () => []),
      sprintIssues,
    };
    const readMap = (boardWorkItemIds: string[]) =>
      loadLivingMapData(loaders, { boardWorkItemIds, cycleId: CURRENT.id, now: Date.now() });
    expect((await readMap([uuid(5), uuid(30)])).issues.get(uuid(30))?.issue_relation).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    await readMap([uuid(5), uuid(30)]);
    vi.advanceTimersByTime(3 * 60_000);
    // Новая карточка вне списка не вызывает чтения: до следующего чтения она нейтральна (без «заблокирована»).
    const later = await readMap([uuid(5), uuid(30), uuid(31)]);
    expect(later.issues.has(uuid(31))).toBe(false);
    expect(later.issues.has(uuid(30))).toBe(true);
    expect(projectIssues).toHaveBeenCalledTimes(1);
    expect(sprintIssues).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(60_000);
    await readMap([uuid(5), uuid(30), uuid(31)]);
    expect(projectIssues).toHaveBeenCalledTimes(2);
    expect(sprintIssues).toHaveBeenCalledTimes(4);
  });

  it("does not remember a failed read of the project list and shares one read between concurrent callers (M-3)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T09:00:00Z"));
    const load = vi
      .fn<() => Promise<ReturnType<typeof issue>[]>>()
      .mockRejectedValueOnce(new Error("Network Error"))
      .mockResolvedValue([issue(30)]);
    const cached = cacheProjectIssues(load);
    await expect(cached()).rejects.toThrow("Network Error");
    const [first, second] = await Promise.all([cached(), cached()]);
    expect(first).toBe(second);
    expect(load).toHaveBeenCalledTimes(2);
    // Кэш — у загрузчиков одной доски: хук карты создаёт их на доску и проект и оборачивает проектный список.
    const hook = read("living-map/living-map-facts.ts");
    has(hook, "projectIssues: cacheProjectIssues(plain.projectIssues)");
    has(hook, "[projectId, workspaceId, workspaceSlug]");
    expect(read("workspace.tsx")).toContain("key={boardId}");
  });

  it("memoizes the switch: CanvasControls re-renders on every drag frame, the switch only on its context (M-2)", () => {
    const toggle = read("living-map/traffic-light-toggle.tsx");
    expect(toggle).toContain("export const PpmTrafficLightToggle = memo(function PpmTrafficLightToggle() {");
    expect((PpmTrafficLightToggle as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for("react.memo"));
    // Без пропсов — memo отсекает каждую перерисовку CanvasControls; значение берётся только из контекста карты.
    expect(read("editor.tsx")).toContain("<PpmTrafficLightToggle />");
  });
});
