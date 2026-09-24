import { describe, expect, it } from "vitest";
import { getBrainPanelSections } from "@/components/ppm-canvas/brain-panel";

describe("brain panel modes", () => {
  it("search mode shows only non-AI sections, question first", () => {
    expect(getBrainPanelSections("search")).toEqual(["query", "results", "index", "sources", "memory"]);
  });

  it("full mode keeps agents and answers after the question", () => {
    const s = getBrainPanelSections("full");
    expect(s[0]).toBe("query");
    expect(s).toEqual(expect.arrayContaining(["agents", "answer", "results", "index", "sources", "memory"]));
  });
});
