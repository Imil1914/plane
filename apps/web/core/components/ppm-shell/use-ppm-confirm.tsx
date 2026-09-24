/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog } from "@headlessui/react";
import { AlertModalCore } from "@plane/ui";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";

export type TPpmConfirmOptions = {
  title: string;
  content: ReactNode;
  confirmLabel?: string;
  variant?: "danger" | "primary";
};

export type TPpmConfirm = (options: TPpmConfirmOptions) => Promise<boolean>;

/**
 * Promise-based replacement for window.confirm() on PPM routes. The Plane alert modal brings
 * Esc/backdrop to cancel, a focus trap and focus return; labels come from @ppm/brand.
 * Render `confirmDialog` once in the calling component.
 */
export function usePpmConfirm(): { confirm: TPpmConfirm; confirmDialog: ReactNode } {
  const ppmT = usePpmTranslation();
  // The last options stay rendered while the modal plays its leave transition.
  const [options, setOptions] = useState<TPpmConfirmOptions>();
  const [isOpen, setIsOpen] = useState(false);
  const resolveRef = useRef<(confirmed: boolean) => void>();

  const settle = useCallback((confirmed: boolean) => {
    const resolve = resolveRef.current;
    resolveRef.current = undefined;
    setIsOpen(false);
    resolve?.(confirmed);
  }, []);

  const confirm = useCallback<TPpmConfirm>(
    (next) =>
      new Promise<boolean>((resolve) => {
        // A newer question supersedes an unanswered one.
        resolveRef.current?.(false);
        resolveRef.current = resolve;
        setOptions(next);
        setIsOpen(true);
      }),
    []
  );

  // Never leave a caller awaiting a dialog that can no longer be answered.
  useEffect(() => () => resolveRef.current?.(false), []);

  const confirmLabel = options?.confirmLabel ?? ppmT("confirm.default_action");
  const confirmDialog = (
    <AlertModalCore
      isOpen={isOpen}
      title={options?.title ?? ""}
      content={<Dialog.Description as="span">{options?.content}</Dialog.Description>}
      variant={options?.variant ?? "danger"}
      isSubmitting={false}
      primaryButtonText={{ default: confirmLabel, loading: confirmLabel }}
      secondaryButtonText={ppmT("confirm.cancel")}
      handleClose={() => settle(false)}
      handleSubmit={() => settle(true)}
    />
  );

  return { confirm, confirmDialog };
}
