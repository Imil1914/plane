/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ReactNode } from "react";
import { AlertTriangle, Inbox, LoaderCircle } from "lucide-react";
import { cn } from "@plane/utils";

type TPpmStateVariant = "empty" | "error" | "loading";

type TPpmStateProps = {
  actions?: ReactNode;
  className?: string;
  description: string;
  title: string;
  variant: TPpmStateVariant;
};

const STATE_ICONS = {
  empty: Inbox,
  error: AlertTriangle,
  loading: LoaderCircle,
} as const;

export function PpmState({ actions, className, description, title, variant }: TPpmStateProps) {
  const Icon = STATE_ICONS[variant];

  return (
    <div
      className={cn("flex min-h-64 w-full items-center justify-center p-6", className)}
      role={variant === "error" ? "alert" : "status"}
    >
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div
          className={cn("grid size-12 place-items-center rounded-2xl border border-subtle bg-surface-2", {
            "text-danger-primary": variant === "error",
            "text-accent-primary": variant !== "error",
          })}
        >
          <Icon className={cn("size-5", variant === "loading" && "animate-spin")} aria-hidden="true" />
        </div>
        <div className="space-y-1.5">
          <h1 className="text-20 font-semibold text-primary">{title}</h1>
          <p className="text-13 leading-5 text-secondary">{description}</p>
        </div>
        {actions}
      </div>
    </div>
  );
}
