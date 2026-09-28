/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Fragment } from "react";
import type { ReactNode } from "react";

/**
 * Renders a flat PPM string with `{name}` placeholders replaced by nodes — e.g. an entity name in its highlighted
 * span inside a confirmation text. Unknown placeholders stay as written.
 */
export function PpmTemplateText({ template, values }: { template: string; values: Record<string, ReactNode> }) {
  const parts = template.split(/(\{\w+\})/g);

  return (
    <>
      {parts.map((part, index) => {
        const name = /^\{(\w+)\}$/.exec(part)?.[1];
        const value = name !== undefined && Object.prototype.hasOwnProperty.call(values, name) ? values[name] : part;
        // oxlint-disable-next-line react/no-array-index-key -- the split order of a fixed template is stable
        return <Fragment key={index}>{value}</Fragment>;
      })}
    </>
  );
}
