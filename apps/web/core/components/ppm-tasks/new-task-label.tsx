/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { PPM_CREATE_WORK_ITEM_KEYS, PpmKbdHint } from "@/components/ppm-shell/kbd-hint";

/**
 * Подпись основной кнопки: реальная последовательность Power-K `ni` (power-k/config/creation/command.ts:73), R9.
 * Клавиши рисует общий `PpmKbdHint` (phase F, ppm-shell/kbd-hint.tsx) — он же держит `aria-hidden` на визуальных
 * клавишах; своего `.ppm-kbd` здесь нет.
 */
export function PpmNewTaskLabel({ label, keysLabel }: { label: string; keysLabel: string }) {
  return (
    <span className="hidden items-center gap-2 sm:inline-flex">
      <span>{label}</span>
      <span className="sr-only">{keysLabel}</span>
      <PpmKbdHint keys={PPM_CREATE_WORK_ITEM_KEYS} tone="on-accent" />
    </span>
  );
}
