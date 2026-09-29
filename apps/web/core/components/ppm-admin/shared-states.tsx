/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// G2.2 review round 1 (#6): `admin-center.tsx` and `git-server-panel.tsx` each imported these from the other,
// a circular import (`admin-center.tsx` also imports `GitServerPanel`). Pulling the three shared states — used by
// every panel of the administration center, not owned by any one of them — into their own file breaks the cycle.
import { Activity } from "lucide-react";
import { Button } from "@plane/propel/button";
import { Spinner } from "@plane/ui";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";

export function ErrorState({ onRetry }: { onRetry: () => void }) {
  const ppmT = usePpmTranslation();
  return (
    <div className="flex min-h-72 flex-col items-center justify-center rounded-xl border border-subtle bg-surface-2 p-8 text-center">
      <Activity className="size-8 text-danger-primary" aria-hidden="true" />
      <p className="mt-3 text-16 font-semibold text-primary">{ppmT("admin.error")}</p>
      <Button className="mt-4" variant="secondary" onClick={onRetry}>
        {ppmT("admin.retry")}
      </Button>
    </div>
  );
}

export function LoadingState() {
  const ppmT = usePpmTranslation();
  return (
    <div className="flex min-h-72 items-center justify-center gap-3 rounded-xl border border-subtle bg-surface-2 text-13 text-secondary">
      <Spinner />
      {ppmT("admin.loading")}
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex min-h-56 items-center justify-center rounded-xl border border-dashed border-subtle bg-surface-2 p-8 text-center text-13 text-secondary">
      {message}
    </div>
  );
}
