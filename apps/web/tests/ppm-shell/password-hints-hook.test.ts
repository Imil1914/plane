/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Line L round 3 (review): behaviour of the Caps Lock part of the password hints — the hook of web, /god-mode and
// space. There is no DOM in these tests, so React's useState is replaced by a plain store: calling the hook again is a
// re-render, and the handlers it returns change that store exactly as React state would.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store: unknown[] = [];
let cursor = 0;

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const slot = cursor++;
      if (!(slot in store)) store[slot] = initial;
      return [store[slot], (next: unknown) => (store[slot] = next)];
    },
  };
});

type THints = {
  isCapsLockOn: boolean;
  inputProps: {
    onKeyDown?: (event: { getModifierState: (key: string) => boolean }) => void;
    onKeyUp?: (event: { getModifierState: (key: string) => boolean }) => void;
    "aria-describedby"?: string;
  };
  resetCapsLock: () => void;
};
type THintsHook = (hintsId: string, enabled: boolean) => THints;

const loadHook = async (path: string) =>
  ((await import(/* @vite-ignore */ fileURLToPath(new URL(path, import.meta.url)))) as Record<string, unknown>)
    .usePasswordFieldHints as THintsHook;

const HOOKS: Array<[string, THintsHook]> = [
  ["web", await loadHook("../../core/components/account/auth-forms/password-field-hints.tsx")],
  ["admin", await loadHook("../../../admin/app/(all)/(home)/password-field-hints.tsx")],
  ["space", await loadHook("../../../space/components/account/auth-forms/password-field-hints.tsx")],
];

/** One render of the hook. */
const render = (hook: THintsHook, enabled = true) => {
  cursor = 0;
  return hook("password-hints", enabled);
};
/** A key event whose Caps Lock state is `on`; records which modifiers were asked about. */
const keyEvent = (on: boolean, asked: string[] = []) => ({
  getModifierState: (key: string) => {
    asked.push(key);
    return key === "CapsLock" && on;
  },
});

beforeEach(() => {
  store.length = 0;
});

describe.each(HOOKS)("%s password hints hook", (_app, hook) => {
  it("links the field to the hints and listens to the keyboard", () => {
    const { isCapsLockOn, inputProps } = render(hook);
    expect(isCapsLockOn).toBe(false);
    expect(inputProps["aria-describedby"]).toBe("password-hints");
    expect(typeof inputProps.onKeyDown).toBe("function");
    expect(typeof inputProps.onKeyUp).toBe("function");
  });

  it("reads Caps Lock from getModifierState on key presses", () => {
    const asked: string[] = [];
    render(hook).inputProps.onKeyDown?.(keyEvent(true, asked));
    expect(asked).toEqual(["CapsLock"]);
    expect(render(hook).isCapsLockOn).toBe(true);
    render(hook).inputProps.onKeyUp?.(keyEvent(false));
    expect(render(hook).isCapsLockOn).toBe(false);
  });

  it("forgets Caps Lock on blur (it may change while the field is not focused)", () => {
    render(hook).inputProps.onKeyDown?.(keyEvent(true));
    expect(render(hook).isCapsLockOn).toBe(true);
    render(hook).resetCapsLock();
    expect(render(hook).isCapsLockOn).toBe(false);
  });

  it("adds nothing to the field with the PPM shell off", () => {
    expect(render(hook, false).inputProps).toEqual({});
  });
});

describe("the password forms forget Caps Lock on blur", () => {
  const FORMS = [
    "../../core/components/account/auth-forms/password.tsx",
    "../../core/components/account/auth-forms/reset-password.tsx",
    "../../core/components/account/auth-forms/set-password.tsx",
    "../../../admin/app/(all)/(home)/sign-in-form.tsx",
    "../../../space/components/account/auth-forms/password.tsx",
  ];

  it.each(FORMS)("%s", (path) => {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    expect(source).toMatch(
      /onBlur=\{(?:passwordHints\.resetCapsLock|\(\) => \{[^}]*passwordHints\.resetCapsLock\(\);\s*\})\}/
    );
  });
});
