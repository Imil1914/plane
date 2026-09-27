/**
 * Copyright (c) 2026 PPM contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PLANE_SOURCE_ATTRIBUTION } from "@ppm/brand";

const EXACT_REVISION = /^[0-9a-f]{40}$/i;

/**
 * Where the source code of the running build is published (AGPL-3.0 §13). Release images are built from one
 * commit of the Plane fork (`deployments/ppm/ppm-build.sh` exports that commit and bakes it into
 * `VITE_PPM_SOURCE_REVISION`), so an exact revision links to that commit in the fork repository; a build without
 * one links to the repository itself.
 */
export function getPpmSourceCodeUrl(
  sourceRevision: string | undefined,
  repository: string = PLANE_SOURCE_ATTRIBUTION.forkRepository
): string {
  const base = repository.replace(/\/+$/, "");
  const revision = sourceRevision?.trim() ?? "";
  return EXACT_REVISION.test(revision) ? `${base}/tree/${revision.toLowerCase()}` : base;
}
