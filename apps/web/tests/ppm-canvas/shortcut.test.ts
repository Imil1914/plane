import { describe, expect, it } from "vitest";
import {
  formatCanvasCommandShortcut,
  shouldCanvasOwnCommandShortcut,
} from "@/components/ppm-canvas/board-workspace-state";

// Minimal element stand-ins: the helper only reads tagName and Node.contains, so no DOM is needed.
function element(tagName: string): Element {
  return { tagName } as Element;
}

function container(...children: Element[]): Element {
  return { tagName: "DIV", contains: (node: Node | null) => children.includes(node as Element) } as Element;
}

describe("canvas command shortcut hint", () => {
  it("shows ⌘K on Apple platforms", () => {
    expect(formatCanvasCommandShortcut("MacIntel")).toBe("⌘K");
    expect(formatCanvasCommandShortcut("macOS")).toBe("⌘K");
    expect(formatCanvasCommandShortcut("iPhone")).toBe("⌘K");
    expect(formatCanvasCommandShortcut("iPad")).toBe("⌘K");
  });

  it("shows Ctrl K everywhere else", () => {
    expect(formatCanvasCommandShortcut("Win32")).toBe("Ctrl K");
    expect(formatCanvasCommandShortcut("Linux x86_64")).toBe("Ctrl K");
    expect(formatCanvasCommandShortcut("")).toBe("Ctrl K");
  });
});

describe("canvas command shortcut ownership", () => {
  it("opens the canvas palette when nothing specific has focus", () => {
    expect(shouldCanvasOwnCommandShortcut(null, null)).toBe(true); // body/null focus → canvas palette
    expect(shouldCanvasOwnCommandShortcut(element("BODY"), container())).toBe(true);
  });

  it("opens the canvas palette when focus is inside the canvas workspace", () => {
    const tab = element("BUTTON");
    expect(shouldCanvasOwnCommandShortcut(tab, container(tab))).toBe(true);
  });

  it("leaves ⌘K to Plane when focus is in Plane's shell or overlays", () => {
    const powerKInput = element("INPUT");
    expect(shouldCanvasOwnCommandShortcut(powerKInput, container(element("BUTTON")))).toBe(false);
    expect(shouldCanvasOwnCommandShortcut(powerKInput, null)).toBe(false);
  });
});
