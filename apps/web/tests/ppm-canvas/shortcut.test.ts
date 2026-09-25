import { describe, expect, it } from "vitest";
import {
  formatCanvasCommandShortcut,
  shouldCanvasOwnCommandShortcut,
  shouldReturnCanvasFocus,
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

describe("canvas palette return-focus (final-fix round 2, I-A)", () => {
  it("restores focus when nothing specific has it — body, or none at all", () => {
    expect(shouldReturnCanvasFocus(null)).toBe(true);
    expect(shouldReturnCanvasFocus(element("BODY"))).toBe(true);
  });

  it("skips restoring focus once a command already put it somewhere real — a new note's title, a dialog", () => {
    const noteTitle = { isConnected: true, tagName: "INPUT" } as Element;
    expect(shouldReturnCanvasFocus(noteTitle)).toBe(false);
  });

  it("restores focus if what had it already left the document", () => {
    const removed = { isConnected: false, tagName: "INPUT" } as Element;
    expect(shouldReturnCanvasFocus(removed)).toBe(true);
  });
});
