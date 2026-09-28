/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Линия B (раунд 3): подтверждение массового удаления — общий AlertModalCore (Esc и фон — отмена, ловушка фокуса,
// возврат фокуса), но первый фокус на «Отмена» (initialFocus="secondary"): два Enter подряд не удаляют N задач.
// Как usePpmConfirm (ppm-shell/use-ppm-confirm.tsx), только с моделью диалога из bulk-flow.ts.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Dialog } from "@headlessui/react";
import { AlertModalCore } from "@plane/ui";
import type { TPpmBulkDeleteDialog } from "./bulk-flow";

export function usePpmBulkDeleteConfirm(): {
  confirm: (dialog: TPpmBulkDeleteDialog) => Promise<boolean>;
  confirmDialog: ReactNode;
} {
  // Последний текст остаётся на экране, пока диалог закрывается.
  const [dialog, setDialog] = useState<TPpmBulkDeleteDialog>();
  const [isOpen, setIsOpen] = useState(false);
  const resolveRef = useRef<(confirmed: boolean) => void>();

  const settle = useCallback((confirmed: boolean) => {
    const resolve = resolveRef.current;
    resolveRef.current = undefined;
    setIsOpen(false);
    resolve?.(confirmed);
  }, []);

  const confirm = useCallback(
    (next: TPpmBulkDeleteDialog) =>
      new Promise<boolean>((resolve) => {
        // Новый вопрос заменяет неотвеченный.
        resolveRef.current?.(false);
        resolveRef.current = resolve;
        setDialog(next);
        setIsOpen(true);
      }),
    []
  );

  // Никого не оставляем ждать ответа от диалога, который уже не ответит.
  useEffect(() => () => resolveRef.current?.(false), []);

  const confirmLabel = dialog?.confirmLabel ?? "";
  const confirmDialog = (
    <AlertModalCore
      isOpen={isOpen}
      title={dialog?.title ?? ""}
      content={
        <Dialog.Description as="span">
          {dialog?.lines.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </Dialog.Description>
      }
      variant="danger"
      isSubmitting={false}
      primaryButtonText={{ default: confirmLabel, loading: confirmLabel }}
      secondaryButtonText={dialog?.cancelLabel ?? ""}
      initialFocus={dialog?.initialFocus ?? "secondary"}
      handleClose={() => settle(false)}
      handleSubmit={() => settle(true)}
    />
  );

  return { confirm, confirmDialog };
}
