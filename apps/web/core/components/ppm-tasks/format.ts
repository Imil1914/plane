/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { MouseEvent } from "react";

/** Подставляет {name} в плоскую строку PPM_TRANSLATIONS (ICU там нет). */
export function formatPpmTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match: string, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
  );
}

/** Делит шаблон вокруг {token}, чтобы вставить моноширинный ID задачи в середину фразы. */
export function splitPpmTemplate(template: string, token: string): [string, string] {
  const marker = `{${token}}`;
  const index = template.indexOf(marker);
  if (index === -1) return [template, ""];
  return [template.slice(0, index), template.slice(index + marker.length)];
}

/** Обычный клик — действие внутри приложения; клик с модификатором или не левой кнопкой — поведение ссылки. */
export function handlePpmSpaClick(event: MouseEvent<HTMLAnchorElement>, onOpen: () => void): void {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  onOpen();
}
