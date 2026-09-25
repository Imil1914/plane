// UX1.1 · Смысловые связи: чистая геометрия маршрута в координатах страницы (без tldraw и React).
// R13: прямая, если карточки на одной линии (общий отрезок проекций ≥ 24); иначе L-образная ломаная с одним
// скруглённым изломом, выход — по стороне к цели. Обхода препятствий нет.
export type TPpmBox = { x: number; y: number; w: number; h: number };
export type TPpmPoint = { x: number; y: number };
export type TPpmEdgeEnd = "arrow" | "bar" | "none";

export type TPpmSemanticEdgeGeometry = {
  route: "straight" | "elbow";
  path: string;
  start: TPpmPoint;
  end: TPpmPoint;
  endDirection: TPpmPoint;
  label: TPpmPoint;
  labelSegmentLength: number;
};

export const SEMANTIC_EDGE_MIN_OVERLAP = 24;
export const SEMANTIC_EDGE_ELBOW_RADIUS = 12;
export const SEMANTIC_EDGE_END_GAP = 2;
const ARROW_LENGTH = 6;
const ARROW_HALF_WIDTH = 4.5;
const BAR_HALF_LENGTH = 5.5;

const round = (value: number) => Math.round(value * 100) / 100 || 0;
const fmt = (point: TPpmPoint) => `${round(point.x)} ${round(point.y)}`;
const distance = (a: TPpmPoint, b: TPpmPoint) => Math.hypot(b.x - a.x, b.y - a.y);
const midpoint = (a: TPpmPoint, b: TPpmPoint): TPpmPoint => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const center = (box: TPpmBox): TPpmPoint => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });

function unit(from: TPpmPoint, to: TPpmPoint): TPpmPoint {
  const length = distance(from, to) || 1;
  return { x: (to.x - from.x) / length || 0, y: (to.y - from.y) / length || 0 };
}

function retract(point: TPpmPoint, direction: TPpmPoint, by: number): TPpmPoint {
  return { x: point.x - direction.x * by, y: point.y - direction.y * by };
}

function straight(start: TPpmPoint, rawEnd: TPpmPoint): TPpmSemanticEdgeGeometry {
  const endDirection = unit(start, rawEnd);
  const end = retract(rawEnd, endDirection, SEMANTIC_EDGE_END_GAP);
  return {
    route: "straight",
    path: `M ${fmt(start)} L ${fmt(end)}`,
    start,
    end,
    endDirection,
    label: midpoint(start, end),
    labelSegmentLength: distance(start, end),
  };
}

function elbow(start: TPpmPoint, corner: TPpmPoint, rawEnd: TPpmPoint): TPpmSemanticEdgeGeometry {
  const endDirection = unit(corner, rawEnd);
  const end = retract(rawEnd, endDirection, SEMANTIC_EDGE_END_GAP);
  const first = distance(start, corner);
  const second = distance(corner, end);
  const radius = Math.min(SEMANTIC_EDGE_ELBOW_RADIUS, first / 2, second / 2);
  const beforeCorner = retract(corner, unit(start, corner), radius);
  const afterCorner = { x: corner.x + endDirection.x * radius, y: corner.y + endDirection.y * radius };
  const [labelFrom, labelTo] = first >= second ? [start, corner] : [corner, end];
  return {
    route: "elbow",
    path: `M ${fmt(start)} L ${fmt(beforeCorner)} Q ${fmt(corner)} ${fmt(afterCorner)} L ${fmt(end)}`,
    start,
    end,
    endDirection,
    label: midpoint(labelFrom, labelTo),
    labelSegmentLength: Math.max(first, second),
  };
}

// Exit point of the ray from the box centre toward `toward` (fallback straight route for degenerate boxes).
function exitPoint(box: TPpmBox, toward: TPpmPoint): TPpmPoint {
  const origin = center(box);
  const dx = toward.x - origin.x;
  const dy = toward.y - origin.y;
  const tx = dx === 0 ? Number.POSITIVE_INFINITY : box.w / 2 / Math.abs(dx);
  const ty = dy === 0 ? Number.POSITIVE_INFINITY : box.h / 2 / Math.abs(dy);
  const t = Math.min(tx, ty);
  return { x: origin.x + dx * t, y: origin.y + dy * t };
}

export function buildSemanticEdgeGeometry(from: TPpmBox, to: TPpmBox): TPpmSemanticEdgeGeometry | null {
  const fromRight = from.x + from.w;
  const fromBottom = from.y + from.h;
  const toRight = to.x + to.w;
  const toBottom = to.y + to.h;
  const overlapX = Math.min(fromRight, toRight) - Math.max(from.x, to.x);
  const overlapY = Math.min(fromBottom, toBottom) - Math.max(from.y, to.y);
  if (overlapX > 0 && overlapY > 0) return null;

  if (overlapY >= SEMANTIC_EDGE_MIN_OVERLAP) {
    const y = Math.max(from.y, to.y) + overlapY / 2;
    const forward = to.x >= fromRight;
    return straight({ x: forward ? fromRight : from.x, y }, { x: forward ? to.x : toRight, y });
  }
  if (overlapX >= SEMANTIC_EDGE_MIN_OVERLAP) {
    const x = Math.max(from.x, to.x) + overlapX / 2;
    const down = to.y >= fromBottom;
    return straight({ x, y: down ? fromBottom : from.y }, { x, y: down ? to.y : toBottom });
  }

  const a = center(from);
  const b = center(to);
  const horizontalFirst = (b.x > fromRight || b.x < from.x) && (a.y < to.y || a.y > toBottom);
  const verticalFirst = (b.y > fromBottom || b.y < from.y) && (a.x < to.x || a.x > toRight);
  const preferHorizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
  if (horizontalFirst && (preferHorizontal || !verticalFirst)) {
    return elbow(
      { x: b.x > a.x ? fromRight : from.x, y: a.y },
      { x: b.x, y: a.y },
      { x: b.x, y: b.y > a.y ? to.y : toBottom }
    );
  }
  if (verticalFirst) {
    return elbow(
      { x: a.x, y: b.y > a.y ? fromBottom : from.y },
      { x: a.x, y: b.y },
      { x: b.x > a.x ? to.x : toRight, y: b.y }
    );
  }
  return straight(exitPoint(from, b), exitPoint(to, a));
}

export function buildSemanticEdgeEnd(end: TPpmPoint, direction: TPpmPoint, kind: TPpmEdgeEnd): string | null {
  if (kind === "none") return null;
  const normal = { x: -direction.y || 0, y: direction.x || 0 };
  if (kind === "bar") {
    const a = { x: end.x + normal.x * BAR_HALF_LENGTH, y: end.y + normal.y * BAR_HALF_LENGTH };
    const b = { x: end.x - normal.x * BAR_HALF_LENGTH, y: end.y - normal.y * BAR_HALF_LENGTH };
    return `M ${fmt(a)} L ${fmt(b)}`;
  }
  const base = retract(end, direction, ARROW_LENGTH);
  const left = { x: base.x + normal.x * ARROW_HALF_WIDTH, y: base.y + normal.y * ARROW_HALF_WIDTH };
  const right = { x: base.x - normal.x * ARROW_HALF_WIDTH, y: base.y - normal.y * ARROW_HALF_WIDTH };
  return `M ${fmt(left)} L ${fmt(end)} L ${fmt(right)}`;
}
