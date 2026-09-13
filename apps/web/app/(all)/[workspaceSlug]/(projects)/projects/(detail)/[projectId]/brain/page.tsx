/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { PpmCanvasRoute } from "@/components/ppm-canvas/route";
import type { Route } from "./+types/page";

export default function ProjectBrainPage({ params }: Route.ComponentProps) {
  return <PpmCanvasRoute {...params} />;
}
