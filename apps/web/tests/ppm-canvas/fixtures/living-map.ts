// AF2.2 M: общие данные тестов «Живой карты» (линия M). ROBOT-N ↔ uuid(N); все id — корректные UUID (zod).
import type { TPpmCanvasBoard, TPpmCanvasGitBinding, TPpmCanvasWorkItemBinding } from "@ppm/canvas";
import type { TMapCycle, TMapIssue, TMapModule, TMapPullRequest } from "@/components/ppm-canvas/living-map/map-model";

type TMapRelation = TMapIssue["issue_relation"][number];
type TStateGroup = "backlog" | "cancelled" | "completed" | "started";

export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const seqOf = (id: string) => Number(id.slice(-12));
export function counter(prefix: string): () => string {
  let value = 0;
  return () => {
    value += 1;
    return `${prefix}${value}`;
  };
}

export const WS = uuid(9001);
export const PROJECT = uuid(9002);
export const BOARD = uuid(9003);
export const USER = uuid(9004);
export const OTHER_PROJECT = uuid(9005);
export const NOW = "2026-09-26T09:00:00.000Z";
export const MECH = uuid(7001);
export const SOFT = uuid(7002);
export const PRES = uuid(7003);
export const MODULES: TMapModule[] = [
  { archived_at: null, id: SOFT, name: "Софт" },
  { archived_at: null, id: MECH, name: "Механика" },
  { archived_at: null, id: PRES, name: "Презентация" },
];
export const STATE = { backlog: uuid(6001), cancelled: uuid(6004), completed: uuid(6003), started: uuid(6002) };
export const STATES = [
  { color: "#8a8a8a", group: "backlog", id: STATE.backlog, name: "Бэклог" },
  { color: "#d97706", group: "started", id: STATE.started, name: "В работе" },
  { color: "#16a34a", group: "completed", id: STATE.completed, name: "Готово" },
  { color: "#9ca3af", group: "cancelled", id: STATE.cancelled, name: "Отменена" },
];
export const PEOPLE = [{ avatar_url: null, display_name: "Миша К.", id: uuid(5001) }];

export function cycle(
  n: number,
  name: string,
  start: string | null,
  end: string | null,
  extra: Partial<TMapCycle> = {}
): TMapCycle {
  return {
    archived_at: null,
    completed_issues: 0,
    end_date: end,
    id: uuid(n),
    name,
    start_date: start,
    total_issues: 0,
    ...extra,
  };
}

export const CURRENT = cycle(8001, "Спринт 3", "2026-09-16", "2026-09-29", { completed_issues: 5, total_issues: 9 });

export function issue(seq: number, moduleIds: string[] = [], extra: Partial<TMapIssue> = {}): TMapIssue {
  return {
    assignee_ids: [],
    cycle_id: CURRENT.id,
    id: uuid(seq),
    issue_relation: [],
    module_ids: moduleIds,
    name: `Задача ${seq}`,
    project_id: PROJECT,
    sequence_id: seq,
    state_id: STATE.started,
    target_date: null,
    ...extra,
  };
}

export function relation(seq: number, relationType: string, extra: Partial<TMapRelation> = {}): TMapRelation {
  return {
    id: uuid(seq),
    name: `Задача ${seq}`,
    project_id: PROJECT,
    relation_type: relationType,
    sequence_id: seq,
    state_id: STATE.started,
    ...extra,
  };
}

export function workItemBinding(
  seq: number,
  shapeId: string,
  options: { dueDate?: string | null; stateGroup?: TStateGroup } = {}
): TPpmCanvasWorkItemBinding & { idempotent_replay: boolean } {
  const state = STATES.find((item) => item.group === (options.stateGroup ?? "started")) ?? STATES[1];
  return {
    binding_id: uuid(50_000 + seq),
    binding_status: "pending",
    entity_id: uuid(seq),
    entity_type: "work_item",
    idempotent_replay: false,
    shape_id: shapeId,
    source: {
      capabilities: { delete_source: false, editable_fields: [], read: true, update: true },
      display: {
        assignees: [],
        due_date: options.dueDate ?? null,
        priority: "none",
        source_status: "active",
        state,
        title: `Задача ${seq}`,
      },
      identity: {
        entity_id: uuid(seq),
        entity_type: "work_item",
        identifier: `ROBOT-${seq}`,
        project_id: PROJECT,
        source_url: `/ws/projects/${PROJECT}/issues/${uuid(seq)}`,
        workspace_id: WS,
      },
      source_version: "1",
    },
    source_version: "1",
  };
}

export function pullRequestBinding(
  n: number,
  shapeId: string,
  sourceUrl = `https://git.example.org/robot/pull/${n}`
): TPpmCanvasGitBinding & { idempotent_replay: boolean } {
  return {
    binding_id: uuid(60_000 + n),
    binding_status: "pending",
    entity_id: uuid(40_000 + n),
    entity_type: "pull_request",
    idempotent_replay: false,
    shape_id: shapeId,
    source: {
      capabilities: { delete_source: false, read: true, update: false },
      display: {
        author_name: "Олег С.",
        base_ref: "main",
        commit_sha: "",
        head_ref: `feature-${n}`,
        object_type: "pull_request",
        provider: "github",
        ref: `#${n}`,
        repository_name: "robot",
        source_status: "active",
        state: "open",
        title: `PR ${n}`,
        work_items: [{ id: uuid(16), identifier: "ROBOT-16", title: "Задача 16" }],
      },
      identity: {
        entity_id: uuid(40_000 + n),
        entity_type: "pull_request",
        project_id: PROJECT,
        source_url: sourceUrl,
        workspace_id: WS,
      },
      source_version: "1",
    },
    source_version: "1",
  };
}

export function pullRequestLink(n: number, workItemSeq: number, extra: Partial<TMapPullRequest> = {}): TMapPullRequest {
  return {
    git_object_id: uuid(40_000 + n),
    id: uuid(30_000 + n),
    object_type: "pull_request",
    ref: String(n),
    repository_name: "robot",
    status: "active",
    title: `ROBOT-${workItemSeq}: PR ${n}`,
    updated_at: "2026-09-25T10:00:00Z",
    work_item: { id: uuid(workItemSeq), identifier: `ROBOT-${workItemSeq}`, title: `Задача ${workItemSeq}` },
    ...extra,
  };
}

export function board(name: string): TPpmCanvasBoard {
  return {
    archived_at: null,
    board_id: BOARD,
    created_at: "2026-09-26T09:00:00+00:00",
    created_by: USER,
    name,
    position: 3,
    status: "active",
    updated_at: "2026-09-26T09:00:00+00:00",
    updated_by: USER,
    version: 0,
  };
}

// Formatting-proof source checks (как af22-foundation.test.ts): oxfmt может переносить вызовы и ставить запятые.
export const norm = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .replace(/([([{]) /g, "$1")
    .replace(/ ([)\]}])/g, "$1")
    .replace(/,([)\]}])/g, "$1");

/** Текст всех блоков `── AF2.2 M: … ── … ── /AF2.2 M ──` файла. */
export function mBlocks(source: string): string {
  const parts: string[] = [];
  let from = source.indexOf("── AF2.2 M:");
  while (from !== -1) {
    const to = source.indexOf("── /AF2.2 M ──", from);
    if (to === -1) break;
    parts.push(source.slice(from, to));
    from = source.indexOf("── AF2.2 M:", to);
  }
  return parts.join("\n");
}
