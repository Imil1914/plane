/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { PpmGitRoute } from "@/components/ppm-git/route";
import type { Route } from "./+types/page";

export default function ProjectCodePage({ params }: Route.ComponentProps) {
  return <PpmGitRoute {...params} />;
}
