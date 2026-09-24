/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { PpmVaultRoute } from "@/components/ppm-vault/route";
import type { Route } from "./+types/page";

export default function ProjectKnowledgePage({ params }: Route.ComponentProps) {
  return <PpmVaultRoute {...params} />;
}
