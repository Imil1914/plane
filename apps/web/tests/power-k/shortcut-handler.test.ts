/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it, vi } from "vitest";
// `ShortcutHandler` reads `window.setTimeout`/`clearTimeout` when scheduling sequence resets
// (`scheduleSequenceReset`). The vitest project for apps/web runs with `environment: "node"`
// (no jsdom/happy-dom installed), so `window` does not exist unless stubbed before import.
vi.stubGlobal("window", { setTimeout, clearTimeout });

import { getShortcutKey, ShortcutHandler } from "@/components/power-k/core/shortcut-handler";
import { PowerKCommandRegistry } from "@/components/power-k/core/registry";
import type { TPowerKCommandConfig, TPowerKContext } from "@/components/power-k/core/types";

describe("getShortcutKey", () => {
  it("maps physical keys so shortcuts work on the Russian layout", () => {
    expect(getShortcutKey({ code: "KeyG", key: "п" })).toBe("g");
    expect(getShortcutKey({ code: "KeyI", key: "ш" })).toBe("i");
    expect(getShortcutKey({ code: "Digit1", key: "1" })).toBe("1");
    expect(getShortcutKey({ code: "Slash", key: "." })).toBe("/");
    expect(getShortcutKey({ code: "Escape", key: "Escape" })).toBe("escape");
  });

  it("maps the remaining punctuation codes regardless of the reported key", () => {
    expect(getShortcutKey({ code: "Comma", key: "б" })).toBe(",");
    expect(getShortcutKey({ code: "Period", key: "ю" })).toBe(".");
    expect(getShortcutKey({ code: "Quote", key: "э" })).toBe("'");
    expect(getShortcutKey({ code: "Semicolon", key: "ж" })).toBe(";");
    expect(getShortcutKey({ code: "BracketLeft", key: "х" })).toBe("[");
    expect(getShortcutKey({ code: "BracketRight", key: "ъ" })).toBe("]");
    expect(getShortcutKey({ code: "Backslash", key: "\\" })).toBe("\\");
    expect(getShortcutKey({ code: "Minus", key: "-" })).toBe("-");
    expect(getShortcutKey({ code: "Equal", key: "=" })).toBe("=");
    expect(getShortcutKey({ code: "Backquote", key: "ё" })).toBe("`");
    expect(getShortcutKey({ code: "Space", key: " " })).toBe("space");
  });

  it("falls back to e.key when e.code is empty (virtual keyboards) or unmapped", () => {
    expect(getShortcutKey({ code: "", key: "Backspace" })).toBe("backspace");
    expect(getShortcutKey({ code: "ArrowUp", key: "ArrowUp" })).toBe("arrowup");
    expect(getShortcutKey({ code: "Enter", key: "Enter" })).toBe("enter");
    expect(getShortcutKey({ code: "", key: " " })).toBe("space");
  });
});

const buildContext = (): TPowerKContext => ({
  params: {},
  activeCommand: null,
  activeContext: null,
  shouldShowContextBasedActions: true,
  setShouldShowContextBasedActions: () => {},
  router: {} as TPowerKContext["router"],
  closePalette: () => {},
  setActiveCommand: () => {},
  setActivePage: () => {},
});

const buildEvent = (code: string, key: string): KeyboardEvent =>
  ({
    code,
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    target: null,
    preventDefault: () => {},
  }) as unknown as KeyboardEvent;

describe("ShortcutHandler with e.code-based key sequences", () => {
  it("resolves a two-key sequence typed on a Russian layout via e.code, not e.key", () => {
    const registry = new PowerKCommandRegistry();
    const action = vi.fn();
    const command: TPowerKCommandConfig = {
      id: "nav_project_work_items",
      type: "action",
      group: "navigation",
      i18n_title: "power_k.navigation_actions.nav_project_work_items",
      keySequence: "gi",
      action,
      isEnabled: () => true,
      isVisible: () => true,
      closeOnSelect: true,
    };
    registry.register(command);

    const handler = new ShortcutHandler(
      registry,
      () => buildContext(),
      () => {}
    );

    // Russian ЙЦУКЕН layout: physical G key reports "п", physical I key reports "ш".
    handler.handleKeyDown(buildEvent("KeyG", "п"));
    handler.handleKeyDown(buildEvent("KeyI", "ш"));

    expect(action).toHaveBeenCalledTimes(1);

    handler.destroy();
  });
});
