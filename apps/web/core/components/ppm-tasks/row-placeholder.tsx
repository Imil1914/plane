/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Row } from "@plane/ui";

/** Плейсхолдер виртуализации v2: высота из того же --ppm-row-height, что и у строки (tasks.css). */
export function PpmTaskRowPlaceholder() {
  return (
    <Row className="ppm-task-row-placeholder flex items-center gap-3 bg-surface-1">
      <span aria-hidden="true" className="h-4 w-14 rounded-sm bg-surface-2" />
      <span aria-hidden="true" className="h-4 w-48 rounded-sm bg-surface-2" />
    </Row>
  );
}
