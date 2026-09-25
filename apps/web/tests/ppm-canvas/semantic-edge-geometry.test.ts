import { describe, expect, it } from "vitest";
import { buildSemanticEdgeEnd, buildSemanticEdgeGeometry } from "@/components/ppm-canvas/semantic-edge-geometry";

const box = (x: number, y: number, w = 100, h = 100) => ({ x, y, w, h });

describe("semantic edge geometry (R13)", () => {
  it("draws a straight horizontal line between cards on one row, from edge to edge", () => {
    const g = buildSemanticEdgeGeometry(box(0, 0), box(200, 20))!;
    expect(g.route).toBe("straight");
    expect(g.path).toBe("M 100 60 L 198 60");
    expect(g.start).toEqual({ x: 100, y: 60 });
    expect(g.endDirection).toEqual({ x: 1, y: 0 });
    expect(g.label).toEqual({ x: 149, y: 60 });
    expect(buildSemanticEdgeGeometry(box(200, 0), box(0, 0))!.path).toBe("M 200 50 L 102 50");
  });

  it("draws a straight vertical line between cards in one column", () => {
    const g = buildSemanticEdgeGeometry(box(0, 0), box(10, 200))!;
    expect(g.path).toBe("M 55 100 L 55 198");
    expect(g.endDirection).toEqual({ x: 0, y: 1 });
  });

  it("returns null for overlapping cards", () => {
    expect(buildSemanticEdgeGeometry(box(0, 0), box(50, 50))).toBeNull();
  });

  it("routes offset cards as one rounded elbow, horizontal first when dx dominates", () => {
    const g = buildSemanticEdgeGeometry(box(0, 0, 240, 168), box(272, 246, 200, 160))!;
    expect(g.route).toBe("elbow");
    expect(g.path).toBe("M 240 84 L 360 84 Q 372 84 372 96 L 372 244");
    expect(g.end).toEqual({ x: 372, y: 244 });
    expect(g.endDirection).toEqual({ x: 0, y: 1 });
    expect(g.label).toEqual({ x: 372, y: 164 });
    expect(g.labelSegmentLength).toBe(160);
  });

  it("routes vertical first when dy dominates", () => {
    const g = buildSemanticEdgeGeometry(box(0, 0), box(150, 300))!;
    expect(g.path).toBe("M 50 100 L 50 338 Q 50 350 62 350 L 148 350");
    expect(g.label).toEqual({ x: 50, y: 225 });
  });

  it("builds an open arrow, a perpendicular bar or nothing at the end", () => {
    expect(buildSemanticEdgeEnd({ x: 198, y: 60 }, { x: 1, y: 0 }, "arrow")).toBe("M 192 64.5 L 198 60 L 192 55.5");
    expect(buildSemanticEdgeEnd({ x: 372, y: 244 }, { x: 0, y: 1 }, "bar")).toBe("M 366.5 244 L 377.5 244");
    expect(buildSemanticEdgeEnd({ x: 0, y: 0 }, { x: 1, y: 0 }, "none")).toBeNull();
  });
});
