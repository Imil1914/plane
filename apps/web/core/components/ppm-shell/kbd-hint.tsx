/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { cn } from "@plane/utils";

/**
 * The real «Новая задача» shortcut: the Power-K creation command keySequence "ni" (R9). Power-K matches e.code,
 * so the Latin keys work in the Russian layout too.
 */
export const PPM_CREATE_WORK_ITEM_KEYS = ["N", "I"] as const;

/** Command search hint: same rule as the canvas palette hint (ppm-canvas/board-workspace-state.ts). */
export function getPpmCommandShortcutLabel(platform: string): string {
  return /mac|iphone|ipad/i.test(platform) ? "⌘K" : "Ctrl K";
}

type TPpmKbdHintProps = {
  /** One box per key; a combination such as "Ctrl K" is one key. */
  keys: readonly string[];
  /** "default" on neutral surfaces; "on-accent" inside the primary (accent) button (TOKENS §9.9). */
  tone?: "default" | "on-accent";
  /** Visibility belongs to the caller, e.g. "hidden ppm-v2:inline-flex" for a v2-only hint. */
  className?: string;
};

/** Visual keyboard hint. aria-hidden: the control keeps its own accessible name. */
export function PpmKbdHint({ keys, tone = "default", className }: TPpmKbdHintProps) {
  return (
    <span aria-hidden="true" className={cn("inline-flex shrink-0 items-center gap-0.5", className)}>
      {keys.map((key) => (
        <kbd
          key={key}
          className={cn(
            "inline-flex h-4 min-w-4 items-center justify-center rounded-sm border px-1 font-code text-11 leading-none font-medium",
            tone === "on-accent"
              ? "border-transparent bg-accent-primary-active text-on-accent"
              : "border-subtle-1 text-tertiary"
          )}
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}
