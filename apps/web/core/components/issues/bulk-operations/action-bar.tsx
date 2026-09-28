/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Линия B (B2): вид панели массовых действий без хуков — всё приходит пропсами, поэтому панель проверяется в тестах
// среды node. Облик v1 и v2 — на семантических токенах (фон, рамки, текст) и общем кольце фокуса PPM.
import type { ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { TrashIcon } from "@plane/propel/icons";
import { cn } from "@plane/utils";
import { PpmKbdHint } from "@/components/ppm-shell/kbd-hint";

export type TPpmBulkButtonTone = "default" | "danger" | "ghost";

/** Классы кнопок панели и меню: неактивная кнопка остаётся фокусируемой (aria-disabled), но выглядит неактивной. */
export function getPpmBulkButtonClassName(tone: TPpmBulkButtonTone, disabled: boolean): string {
  return cn(
    "inline-flex h-7 flex-shrink-0 items-center gap-1.5 rounded-md px-2 text-13 whitespace-nowrap transition-colors focus-visible:outline-none",
    {
      "border border-subtle-1 text-secondary": tone === "default",
      "text-danger-primary": tone === "danger",
      "text-secondary": tone === "ghost",
      "hover:bg-layer-transparent-hover hover:text-primary": !disabled && tone !== "danger",
      "hover:bg-danger-subtle": !disabled && tone === "danger",
      "cursor-not-allowed text-disabled": disabled,
    }
  );
}

type TPpmBulkButtonProps = {
  /** Основа id подсказки: `${id}-hint`. */
  id: string;
  label: string;
  /** Почему кнопка неактивна; null — активна. */
  hint: string | null;
  /** Пояснение к активной кнопке («Можно удалить 2 из 4») — видно заранее, кнопку не выключает. */
  note?: string | null;
  /** Идёт действие — кнопка неактивна без подсказки. */
  busy?: boolean;
  tone?: TPpmBulkButtonTone;
  icon?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
};

/** Кнопка панели. Неактивная — aria-disabled + подсказка (title и текст для экранного диктора), не `disabled`. */
export function PpmBulkButton(props: TPpmBulkButtonProps) {
  const { id, label, hint, note = null, busy = false, tone = "default", icon, trailing, onClick } = props;
  const inactive = busy || !!hint;
  const hintId = `${id}-hint`;
  const description = hint ?? (busy ? null : note);
  return (
    <>
      <button
        type="button"
        id={id}
        className={getPpmBulkButtonClassName(tone, inactive)}
        aria-disabled={inactive || undefined}
        aria-describedby={description ? hintId : undefined}
        title={description ?? undefined}
        onClick={inactive ? undefined : onClick}
      >
        {icon}
        <span>{label}</span>
        {trailing}
      </button>
      {description && (
        <span id={hintId} className="sr-only">
          {description}
        </span>
      )}
    </>
  );
}

export type TPpmBulkActionBarViewProps = {
  regionLabel: string;
  /** «Выбрано: 3 задачи». */
  countLabel: string;
  busy: boolean;
  busyLabel: string;
  isDesignV2: boolean;
  className?: string;
  /** Меню «Статус», «Исполнитель», «Спринт» (строит контейнер). */
  pickers: ReactNode;
  deleteLabel: string;
  deleteHint: string | null;
  /** «Можно удалить K из N», когда удалить можно не все выделенные задачи. */
  deleteNote?: string | null;
  onDelete: () => void;
  clearLabel: string;
  onClear: () => void;
};

export function PpmBulkActionBarView(props: TPpmBulkActionBarViewProps) {
  const {
    regionLabel,
    countLabel,
    busy,
    busyLabel,
    isDesignV2,
    className,
    pickers,
    deleteLabel,
    deleteHint,
    deleteNote = null,
    onDelete,
    clearLabel,
    onClear,
  } = props;

  return (
    <div
      className={cn("sticky bottom-0 left-0 z-[5] flex w-full flex-shrink-0 justify-center px-3 pt-2 pb-3", className)}
    >
      <div
        role="region"
        aria-label={regionLabel}
        aria-busy={busy || undefined}
        className={cn(
          "flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 border border-subtle-1 bg-surface-1 px-3 py-2 shadow-raised-200",
          isDesignV2 ? "rounded-lg" : "rounded-md"
        )}
      >
        <span
          aria-live="polite"
          className={cn("text-13 font-medium whitespace-nowrap text-primary", { "tabular-nums": isDesignV2 })}
        >
          {countLabel}
        </span>
        <span aria-hidden="true" className="h-5 flex-shrink-0 border-l border-subtle-1" />
        <div className="flex flex-wrap items-center gap-1.5">{pickers}</div>
        <PpmBulkButton
          id="ppm-bulk-delete"
          label={deleteLabel}
          hint={busy ? null : deleteHint}
          note={deleteNote}
          busy={busy}
          tone="danger"
          icon={<TrashIcon className="size-3.5 flex-shrink-0" aria-hidden="true" />}
          onClick={onDelete}
        />
        <span aria-hidden="true" className="flex-1" />
        {busy && (
          <span role="status" className="flex items-center gap-1.5 text-12 whitespace-nowrap text-secondary">
            <LoaderCircle className="size-3.5 animate-spin text-accent-primary" aria-hidden="true" />
            {busyLabel}
          </span>
        )}
        <PpmBulkButton
          id="ppm-bulk-clear"
          label={clearLabel}
          hint={null}
          busy={busy}
          tone="ghost"
          trailing={<PpmKbdHint keys={["Esc"]} />}
          onClick={onClear}
        />
      </div>
    </div>
  );
}
