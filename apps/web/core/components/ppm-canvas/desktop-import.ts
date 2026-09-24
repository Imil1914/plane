import {
  createPpmCanvasNode,
  isPpmMermaidSourceSafe,
  updatePpmCanvasNode,
  type TPpmCanvasOwnedNode,
  type TPpmCanvasOwnedNodeKind,
} from "@ppm/canvas";
import type { TLArrowShape } from "tldraw";

export const MAX_DESKTOP_IMPORT_BYTES = 20 * 1024 * 1024;
export const MAX_CANVAS_IMPORT_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_DESKTOP_SHAPES = 1_000;
const DEFERRED_AI_KINDS = new Set([
  "ai",
  "answer",
  "anythingllm",
  "opencode",
  "openscience",
  "orchcall",
  "orchestrator",
  "orchtask",
  "webgemini",
  "webglm",
  "webgpt",
]);
const SAFE_PLACEHOLDER_TEXT_KINDS = new Set([
  "board",
  "daylane",
  "deck",
  "image",
  "kanban",
  "list",
  "listcard",
  "notebook",
  "pdf",
  "ref",
  "sheet",
  "slide",
  "tlaxis",
]);

export type TPpmDesktopImportShape = {
  node: TPpmCanvasOwnedNode;
  parentSourceId?: string;
  sourceId: string;
  sourceKind: string;
  status: "converted" | "placeholder";
  rotation: number;
  x: number;
  y: number;
};

export type TPpmDesktopImportConnection = {
  parentSourceId?: string;
  sourceId: string;
  sourceKind: "arrow";
  fromSourceId: string;
  toSourceId: string;
  fromBinding: TPpmDesktopImportArrowBinding;
  toBinding: TPpmDesktopImportArrowBinding;
  style: TPpmDesktopImportArrowStyle;
  status: "converted";
};

export type TPpmDesktopImportFreeArrow = {
  parentSourceId?: string;
  sourceId: string;
  sourceKind: "arrow";
  status: "converted";
  rotation: number;
  x: number;
  y: number;
  start: TLArrowShape["props"]["start"];
  end: TLArrowShape["props"]["end"];
  style: TPpmDesktopImportArrowStyle;
};

export type TPpmDesktopImportGroup = {
  parentSourceId?: string;
  sourceId: string;
  rotation: number;
  x: number;
  y: number;
};

export type TPpmDesktopImportArrowStyle = Pick<
  TLArrowShape["props"],
  | "kind"
  | "color"
  | "labelColor"
  | "fill"
  | "dash"
  | "size"
  | "arrowheadStart"
  | "arrowheadEnd"
  | "font"
  | "bend"
  | "text"
  | "labelPosition"
  | "scale"
  | "elbowMidPoint"
>;

export type TPpmDesktopImportArrowBinding = {
  normalizedAnchor: { x: number; y: number };
  isExact: boolean;
  isPrecise: boolean;
  snap: "center" | "edge-point" | "edge" | "none";
};

type TPpmDesktopImportItem = {
  sourceId: string;
  sourceKind: string;
  status: "converted" | "placeholder";
};

export type TPpmDesktopImportPlan = {
  assetCount: number;
  connections: TPpmDesktopImportConnection[];
  convertedCount: number;
  freeArrows: TPpmDesktopImportFreeArrow[];
  groups: TPpmDesktopImportGroup[];
  hasLegacyExtras: boolean;
  hasFlattenedHierarchy: boolean;
  hasRotations: boolean;
  items: TPpmDesktopImportItem[];
  placeholderCount: number;
  shapes: TPpmDesktopImportShape[];
  unsupportedKinds: string[];
};

export type TPpmDesktopImportReport = {
  format: "ppm-desktop-import-report";
  schema_version: 3;
  source_name: string;
  converted_count: number;
  free_arrow_count: number;
  placeholder_count: number;
  asset_count: number;
  has_legacy_extras: boolean;
  has_flattened_hierarchy: boolean;
  has_rotations: boolean;
  items: { source_id: string; source_kind: string; status: "converted" | "placeholder" }[];
  warning: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

type TSimpleDesktopSheet = { rows: number; cols: number; cells: Record<string, string> };

function simpleDesktopSheet(props: Record<string, unknown>): TSimpleDesktopSheet | undefined {
  if (typeof props.body === "string" && props.body.trim()) return undefined;
  if (typeof props.extra !== "string") return undefined;
  let extra: unknown;
  try {
    extra = JSON.parse(props.extra || "{}");
  } catch {
    return undefined;
  }
  if (!isRecord(extra) || Object.keys(extra).some((key) => key !== "sheet")) return undefined;
  const sheet = Object.hasOwn(extra, "sheet") ? extra.sheet : { rows: 6, cols: 5, cells: {} };
  if (!isRecord(sheet)) return undefined;
  const rows = sheet.rows;
  const cols = sheet.cols;
  if (
    Object.keys(sheet).some((key) => !["rows", "cols", "cells", "colW", "rowH"].includes(key)) ||
    typeof rows !== "number" ||
    typeof cols !== "number" ||
    !Number.isInteger(rows) ||
    !Number.isInteger(cols) ||
    rows < 1 ||
    rows > 500 ||
    cols < 1 ||
    cols > 20 ||
    !isRecord(sheet.cells) ||
    (isRecord(sheet.colW) && Object.keys(sheet.colW).length > 0) ||
    (isRecord(sheet.rowH) && Object.keys(sheet.rowH).length > 0) ||
    (sheet.colW !== undefined && !isRecord(sheet.colW)) ||
    (sheet.rowH !== undefined && !isRecord(sheet.rowH))
  )
    return undefined;
  const cells: Record<string, string> = {};
  for (const [key, value] of Object.entries(sheet.cells)) {
    const match = /^(\d+):(\d+)$/.exec(key);
    const row = match ? Number(match[1]) : NaN;
    const col = match ? Number(match[2]) : NaN;
    if (
      !match ||
      !Number.isSafeInteger(row) ||
      !Number.isSafeInteger(col) ||
      `${row}:${col}` !== key ||
      row >= rows ||
      col >= cols ||
      typeof value !== "string" ||
      value.length > 5_000 ||
      value.trimStart().startsWith("=")
    )
      return undefined;
    cells[key] = value;
  }
  return { rows, cols, cells };
}

function desktopKindToPpmKind(kind: string, body: string): TPpmCanvasOwnedNodeKind | undefined {
  if (kind === "note") return "note";
  if (kind === "group") return "group";
  if (kind === "doc") return "document";
  if (kind === "code" || kind === "codeblock") return "code";
  if (kind === "diagram" && isPpmMermaidSourceSafe(body)) return "diagram";
  return undefined;
}

function isConvertibleDesktopFrame(props: Record<string, unknown>): boolean {
  return (
    typeof props.w === "number" &&
    Number.isFinite(props.w) &&
    props.w >= 160 &&
    props.w <= 1600 &&
    typeof props.h === "number" &&
    Number.isFinite(props.h) &&
    props.h >= 96 &&
    props.h <= 1200 &&
    (props.name === undefined || (typeof props.name === "string" && props.name.length <= 160))
  );
}

function isDeferredAiKind(kind: string): boolean {
  return DEFERRED_AI_KINDS.has(kind) || /(?:^|[-_])(ai|agent|orchestrator|llm|gpt|gemini|glm)(?:$|[-_])/i.test(kind);
}

function desktopArrowBinding(props: Record<string, unknown>): TPpmDesktopImportArrowBinding | undefined {
  const anchor = props.normalizedAnchor;
  if (
    anchor !== undefined &&
    (!isRecord(anchor) ||
      typeof anchor.x !== "number" ||
      !Number.isFinite(anchor.x) ||
      anchor.x < 0 ||
      anchor.x > 1 ||
      typeof anchor.y !== "number" ||
      !Number.isFinite(anchor.y) ||
      anchor.y < 0 ||
      anchor.y > 1)
  )
    return undefined;
  const isExact = props.isExact;
  const isPrecise = props.isPrecise;
  const snap = props.snap;
  if (
    (isExact !== undefined && typeof isExact !== "boolean") ||
    (isPrecise !== undefined && typeof isPrecise !== "boolean") ||
    (snap !== undefined && (typeof snap !== "string" || !["center", "edge-point", "edge", "none"].includes(snap)))
  )
    return undefined;
  return {
    normalizedAnchor: anchor ? { x: anchor.x as number, y: anchor.y as number } : { x: 0.5, y: 0.5 },
    isExact: isExact === true,
    isPrecise: typeof isPrecise === "boolean" ? isPrecise : anchor !== undefined,
    snap: (snap ?? "none") as TPpmDesktopImportArrowBinding["snap"],
  };
}

function arrowEnum<T extends string>(value: unknown, choices: readonly T[], fallback: T): T | undefined {
  if (value === undefined) return fallback;
  return typeof value === "string" && choices.includes(value as T) ? (value as T) : undefined;
}

function arrowNumber(value: unknown, fallback: number, nonzero = false): number | undefined {
  if (value === undefined) return fallback;
  return typeof value === "number" && Number.isFinite(value) && (!nonzero || value !== 0) ? value : undefined;
}

const DESKTOP_ARROW_PROP_KEYS = new Set([
  "kind",
  "color",
  "labelColor",
  "fill",
  "dash",
  "size",
  "arrowheadStart",
  "arrowheadEnd",
  "font",
  "bend",
  "text",
  "labelPosition",
  "scale",
  "elbowMidPoint",
  "start",
  "end",
]);

function desktopArrowStyle(props: Record<string, unknown>): TPpmDesktopImportArrowStyle | undefined {
  const colors = [
    "black",
    "grey",
    "light-violet",
    "violet",
    "blue",
    "light-blue",
    "yellow",
    "orange",
    "green",
    "light-green",
    "light-red",
    "red",
    "white",
  ] as const;
  const arrowheads = ["arrow", "triangle", "square", "dot", "pipe", "diamond", "inverted", "bar", "none"] as const;
  const style = {
    kind: arrowEnum(props.kind, ["arc", "elbow"] as const, "arc"),
    color: arrowEnum(props.color, colors, "black"),
    labelColor: arrowEnum(props.labelColor, colors, "black"),
    fill: arrowEnum(props.fill, ["none", "semi", "solid", "pattern", "fill"] as const, "none"),
    dash: arrowEnum(props.dash, ["draw", "solid", "dashed", "dotted"] as const, "draw"),
    size: arrowEnum(props.size, ["s", "m", "l", "xl"] as const, "m"),
    arrowheadStart: arrowEnum(props.arrowheadStart, arrowheads, "none"),
    arrowheadEnd: arrowEnum(props.arrowheadEnd, arrowheads, "arrow"),
    font: arrowEnum(props.font, ["draw", "sans", "serif", "mono"] as const, "draw"),
    bend: arrowNumber(props.bend, 0),
    labelPosition: arrowNumber(props.labelPosition, 0.5),
    scale: arrowNumber(props.scale, 1, true),
    elbowMidPoint: arrowNumber(props.elbowMidPoint, 0.5),
  };
  if (Object.values(style).some((value) => value === undefined)) return undefined;
  const text = props.text === undefined ? "" : props.text;
  if (typeof text !== "string" || text.length > 1_000) return undefined;
  return { ...style, text } as TPpmDesktopImportArrowStyle;
}

function desktopFreeArrowEndpoint(value: unknown): TLArrowShape["props"]["start"] | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "x" && key !== "y") ||
    typeof value.x !== "number" ||
    !Number.isFinite(value.x) ||
    typeof value.y !== "number" ||
    !Number.isFinite(value.y)
  )
    return undefined;
  return { x: value.x, y: value.y };
}

function isDesktopFreeArrowGeometryValid(
  start: TLArrowShape["props"]["start"],
  end: TLArrowShape["props"]["end"],
  transform: { x: number; y: number; rotation: number }
): boolean {
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (!Number.isFinite(length) || length === 0) return false;
  const cosine = Math.cos(transform.rotation);
  const sine = Math.sin(transform.rotation);
  return [start, end].every((point) =>
    [transform.x + cosine * point.x - sine * point.y, transform.y + sine * point.x + cosine * point.y].every(
      Number.isFinite
    )
  );
}

export function createDesktopImportReport(plan: TPpmDesktopImportPlan, sourceName: string): TPpmDesktopImportReport {
  return {
    format: "ppm-desktop-import-report",
    schema_version: 3,
    source_name: sourceName,
    converted_count: plan.convertedCount,
    free_arrow_count: plan.freeArrows.length,
    placeholder_count: plan.placeholderCount,
    asset_count: plan.assetCount,
    has_legacy_extras: plan.hasLegacyExtras,
    has_flattened_hierarchy: plan.hasFlattenedHierarchy,
    has_rotations: plan.hasRotations,
    items: plan.items.map(({ sourceId, sourceKind, status }) => ({
      source_id: sourceId,
      source_kind: sourceKind,
      status,
    })),
    warning:
      "Частичный перенос. Сохраните исходный .flow.json: вложенность поддерживаемых групп и рамок сохраняется, вложенность остальных объектов уплощается; файлы, формулы и содержимое AI/агентов перенесены не полностью.",
  };
}

export function prepareDesktopFlowImport(raw: string, authorId: string): TPpmDesktopImportPlan {
  if (new TextEncoder().encode(raw).byteLength > MAX_DESKTOP_IMPORT_BYTES)
    throw new Error("Desktop board file exceeds the import size limit.");

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Desktop board JSON is invalid.");
  }
  if (
    !isRecord(value) ||
    !isRecord(value.document) ||
    !isRecord(value.document.store) ||
    !isRecord(value.document.schema)
  )
    throw new Error("This is not a desktop AntyFlow board snapshot.");

  const records = Object.values(value.document.store);
  const pages = records.filter((record) => isRecord(record) && record.typeName === "page");
  if (pages.length > 1) throw new Error("Multi-page desktop snapshots require separate board migration.");
  const shapeRecords = records.filter((record) => isRecord(record) && record.typeName === "shape");
  if (shapeRecords.length === 0 || shapeRecords.length > MAX_DESKTOP_SHAPES)
    throw new Error("Desktop board must contain between 1 and 1000 shapes.");

  const sourceShapes = new Map<string, Record<string, unknown>>();
  for (const record of shapeRecords) {
    if (!isRecord(record) || typeof record.id !== "string" || typeof record.type !== "string")
      throw new Error("Desktop board contains an invalid shape record.");
    if (sourceShapes.has(record.id)) throw new Error("Desktop board contains duplicate shape ids.");
    sourceShapes.set(record.id, record);
  }
  const directChildCounts = new Map<string, number>();
  for (const record of shapeRecords) {
    if (!isRecord(record) || typeof record.parentId !== "string" || !sourceShapes.has(record.parentId)) continue;
    directChildCounts.set(record.parentId, (directChildCounts.get(record.parentId) ?? 0) + 1);
  }

  const pageIds = new Set(pages.map((page) => (isRecord(page) && typeof page.id === "string" ? page.id : "")));
  const pageTransforms = new Map<string, { x: number; y: number; rotation: number }>();
  const resolvingParents = new Set<string>();
  const pageTransform = (id: string): { x: number; y: number; rotation: number } => {
    const cached = pageTransforms.get(id);
    if (cached) return cached;
    const record = sourceShapes.get(id);
    if (!record || resolvingParents.has(id)) throw new Error("Desktop board has an invalid shape hierarchy.");
    for (const key of ["x", "y", "rotation"] as const) {
      if (record[key] !== undefined && (typeof record[key] !== "number" || !Number.isFinite(record[key])))
        throw new Error("Desktop board has an invalid shape transform.");
    }
    resolvingParents.add(id);
    try {
      const x = finiteNumber(record.x, 0);
      const y = finiteNumber(record.y, 0);
      const rotation = finiteNumber(record.rotation, 0);
      const parentId = record.parentId;
      let result = { x, y, rotation };
      if (parentId !== undefined) {
        if (typeof parentId !== "string") throw new Error("Desktop board has an invalid shape parent.");
        if (parentId.startsWith("page:")) {
          if (pageIds.size > 0 && !pageIds.has(parentId)) throw new Error("Desktop board refers to an unknown page.");
        } else {
          const parent = pageTransform(parentId);
          result = {
            x: parent.x + Math.cos(parent.rotation) * x - Math.sin(parent.rotation) * y,
            y: parent.y + Math.sin(parent.rotation) * x + Math.cos(parent.rotation) * y,
            rotation: parent.rotation + rotation,
          };
        }
      }
      if (!Number.isFinite(result.x) || !Number.isFinite(result.y) || !Number.isFinite(result.rotation))
        throw new Error("Desktop board has an invalid shape transform.");
      pageTransforms.set(id, result);
      return result;
    } finally {
      resolvingParents.delete(id);
    }
  };

  const arrowBindings = new Map<
    string,
    {
      start?: { targetId: string; props: TPpmDesktopImportArrowBinding };
      end?: { targetId: string; props: TPpmDesktopImportArrowBinding };
      invalid: boolean;
    }
  >();
  const arrowsWithAnyBindings = new Set<string>();
  for (const record of records) {
    if (!isRecord(record) || record.typeName !== "binding") continue;
    if (typeof record.fromId !== "string" || sourceShapes.get(record.fromId)?.type !== "arrow") continue;
    arrowsWithAnyBindings.add(record.fromId);
    if (record.type !== "arrow") continue;
    const binding = arrowBindings.get(record.fromId) ?? { invalid: false };
    const bindingProps = isRecord(record.props) ? record.props : {};
    const terminal = bindingProps.terminal;
    const target = typeof record.toId === "string" ? sourceShapes.get(record.toId) : undefined;
    const importedTarget =
      target?.type === "flow-node" ||
      (target?.type === "frame" && isConvertibleDesktopFrame(isRecord(target.props) ? target.props : {}));
    const normalizedBinding = desktopArrowBinding(bindingProps);
    if (
      (terminal !== "start" && terminal !== "end") ||
      typeof record.toId !== "string" ||
      !importedTarget ||
      !normalizedBinding ||
      binding[terminal]
    )
      binding.invalid = true;
    else binding[terminal] = { targetId: record.toId, props: normalizedBinding };
    arrowBindings.set(record.fromId, binding);
  }

  const shapes: TPpmDesktopImportShape[] = [];
  const connections: TPpmDesktopImportConnection[] = [];
  const freeArrows: TPpmDesktopImportFreeArrow[] = [];
  const groups: TPpmDesktopImportGroup[] = [];
  const items: TPpmDesktopImportItem[] = [];
  const unsupportedKinds = new Set<string>();
  let hasLegacyExtras = false;
  let hasRotations = false;

  for (const record of shapeRecords) {
    if (!isRecord(record) || typeof record.id !== "string" || typeof record.type !== "string")
      throw new Error("Desktop board contains an invalid shape record.");
    const props = isRecord(record.props) ? record.props : {};
    const sourceKind = record.type === "flow-node" && typeof props.kind === "string" ? props.kind : record.type;
    const transform = pageTransform(record.id);
    const parentSourceId =
      typeof record.parentId === "string" && sourceShapes.has(record.parentId) ? record.parentId : undefined;
    if (finiteNumber(record.rotation, 0) !== 0) hasRotations = true;
    // tldraw deletes a native group with fewer than two direct children.
    // Keep those as explicit placeholders instead of claiming the group survived.
    if (record.type === "group" && (directChildCounts.get(record.id) ?? 0) >= 2) {
      if (Object.keys(props).length > 0) hasLegacyExtras = true;
      groups.push({ parentSourceId, sourceId: record.id, ...transform });
      items.push({ sourceId: record.id, sourceKind, status: "converted" });
      continue;
    }
    if (record.type === "arrow") {
      const binding = arrowBindings.get(record.id);
      const style = desktopArrowStyle(props);
      if (Object.keys(props).some((key) => !DESKTOP_ARROW_PROP_KEYS.has(key))) hasLegacyExtras = true;
      if (
        binding &&
        !binding.invalid &&
        binding.start &&
        binding.end &&
        binding.start.targetId !== binding.end.targetId &&
        style
      ) {
        connections.push({
          parentSourceId,
          sourceId: record.id,
          sourceKind: "arrow",
          fromSourceId: binding.start.targetId,
          toSourceId: binding.end.targetId,
          fromBinding: binding.start.props,
          toBinding: binding.end.props,
          style,
          status: "converted",
        });
        items.push({ sourceId: record.id, sourceKind, status: "converted" });
        continue;
      }
      if (!arrowsWithAnyBindings.has(record.id) && style) {
        const start = desktopFreeArrowEndpoint(props.start);
        const end = desktopFreeArrowEndpoint(props.end);
        if (start && end && isDesktopFreeArrowGeometryValid(start, end, transform)) {
          freeArrows.push({
            parentSourceId,
            sourceId: record.id,
            sourceKind: "arrow",
            status: "converted",
            rotation: transform.rotation,
            x: transform.x,
            y: transform.y,
            start,
            end,
            style,
          });
          items.push({ sourceId: record.id, sourceKind, status: "converted" });
          continue;
        }
      }
    }
    const body = typeof props.body === "string" ? props.body : "";
    const sheet = record.type === "flow-node" && sourceKind === "sheet" ? simpleDesktopSheet(props) : undefined;
    const convertedKind = sheet
      ? "table"
      : record.type === "flow-node"
        ? desktopKindToPpmKind(sourceKind, body)
        : record.type === "frame" && isConvertibleDesktopFrame(props)
          ? "frame"
          : undefined;
    const mayCopyText =
      !isDeferredAiKind(sourceKind) &&
      record.type === "flow-node" &&
      Boolean(convertedKind || SAFE_PLACEHOLDER_TEXT_KINDS.has(sourceKind));
    const title =
      convertedKind === "frame"
        ? typeof props.name === "string" && props.name.trim()
          ? props.name.trim()
          : "Рамка"
        : mayCopyText && typeof props.title === "string" && props.title.trim()
          ? props.title.trim()
          : sourceKind;
    if (title.length > 160 || (mayCopyText && body.length > 50_000))
      throw new Error("Desktop node text exceeds the PPM node limit; the board was not changed.");

    const status = convertedKind ? "converted" : "placeholder";
    if (!convertedKind) unsupportedKinds.add(sourceKind);
    if (typeof props.extra === "string" && props.extra.trim() && props.extra.trim() !== "{}" && !sheet)
      hasLegacyExtras = true;

    // Deferred AI/service nodes become inert placeholders without copying their
    // prompts, histories, models or credentials into a shared project board.
    const safeBody = mayCopyText ? body : "";
    const node = createPpmCanvasNode({
      authorId,
      body: safeBody,
      kind: convertedKind ?? "note",
      title,
    });
    const width = Math.min(1600, Math.max(160, finiteNumber(props.w, node.visual.width)));
    const height = Math.min(1200, Math.max(96, finiteNumber(props.h, node.visual.height)));
    const sizedNode = updatePpmCanvasNode(node, { visual: { ...node.visual, width, height } });
    let importedNode: TPpmCanvasOwnedNode = sizedNode;
    if (sheet && sizedNode.kind === "table") {
      const columns = Array.from({ length: sheet.cols }, (_, index) => ({
        id: `column-${index}`,
        label: String.fromCharCode(65 + index),
      }));
      importedNode = updatePpmCanvasNode(sizedNode, {
        columns,
        rows: Array.from({ length: sheet.rows }, (_, rowIndex) => ({
          id: `row-${rowIndex}`,
          cells: Object.fromEntries(
            columns.map((column, columnIndex) => [column.id, sheet.cells[`${rowIndex}:${columnIndex}`] ?? ""])
          ),
        })),
      });
    }
    shapes.push({
      node: {
        ...importedNode,
        legacy_desktop: { source_id: record.id, source_kind: sourceKind, migration_status: status },
      },
      parentSourceId,
      sourceId: record.id,
      sourceKind,
      status,
      rotation: transform.rotation,
      x: transform.x,
      y: transform.y,
    });
    items.push({ sourceId: record.id, sourceKind, status });
  }

  const containerSourceIds = new Set([
    ...groups.map(({ sourceId }) => sourceId),
    ...shapes
      .filter(({ node, status }) => status === "converted" && (node.kind === "group" || node.kind === "frame"))
      .map(({ sourceId }) => sourceId),
  ]);
  const hasFlattenedHierarchy = shapeRecords.some(
    (record) =>
      isRecord(record) &&
      typeof record.parentId === "string" &&
      sourceShapes.has(record.parentId) &&
      !containerSourceIds.has(record.parentId)
  );

  return {
    assetCount: records.filter((record) => isRecord(record) && record.typeName === "asset").length,
    connections,
    convertedCount:
      shapes.filter((shape) => shape.status === "converted").length +
      groups.length +
      connections.length +
      freeArrows.length,
    freeArrows,
    groups,
    hasLegacyExtras,
    hasFlattenedHierarchy,
    hasRotations,
    items,
    placeholderCount: shapes.filter((shape) => shape.status === "placeholder").length,
    shapes,
    unsupportedKinds: [...unsupportedKinds],
  };
}
