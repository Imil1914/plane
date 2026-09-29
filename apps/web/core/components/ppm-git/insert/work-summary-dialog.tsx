// G2.3 (line G-Web, G4): the «Что сделано за период» dialog — period presets, a preview (totals + the work-item
// list), and an «Вставить» action that hands the caller the ready `html`/`markdown` text from the API (the contract
// already builds both, in Russian, links restricted to this project — see plan.md). Pages insert `summary.html`,
// Vault notes insert `summary.markdown`; this file does not choose between them, the call site does.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Dialog } from "@headlessui/react";
import { GitPullRequest, LoaderCircle, X } from "lucide-react";
import { EModalWidth, ModalCore } from "@plane/ui";
import { Tooltip } from "@plane/propel/tooltip";
import type { TPpmTranslationKey } from "@ppm/brand";
import { handlePpmDialogKeyDown, shouldDismissPpmDialog } from "@/helpers/ppm-dialog-dismiss.helper";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { PpmGitService, type TPpmGitWorkSummary } from "@/services/ppm-git.service";
import {
  createWorkSummaryController,
  type TWorkSummaryController,
  type TWorkSummaryControllerState,
} from "./work-summary-controller";
import type { TWorkSummaryPreset } from "./work-summary-period";

const gitService = new PpmGitService();

const PRESETS: TWorkSummaryPreset[] = ["this_week", "last_week", "two_weeks", "month", "custom"];

const PRESET_LABEL_KEYS: Record<TWorkSummaryPreset, TPpmTranslationKey> = {
  this_week: "g23.summary.preset_this_week",
  last_week: "g23.summary.preset_last_week",
  two_weeks: "g23.summary.preset_two_weeks",
  month: "g23.summary.preset_month",
  custom: "g23.summary.preset_custom",
};

type TDeps = { workspaceId: string; projectId: string };

function useWorkSummaryController(deps: TDeps): {
  controller: TWorkSummaryController;
  state: TWorkSummaryControllerState;
} {
  const depsRef = useRef(deps);
  useEffect(() => {
    depsRef.current = deps;
  });
  const [controller] = useState(() =>
    createWorkSummaryController({
      getSummary: ({ from, to }) => {
        const { workspaceId, projectId } = depsRef.current;
        return gitService.getWorkSummary(workspaceId, projectId, { from, to });
      },
    })
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  useEffect(() => {
    controller.start();
    return () => controller.dispose();
  }, [controller]);
  return { controller, state };
}

export type TWorkSummaryDialogProps = {
  open: boolean;
  workspaceId: string;
  projectId: string;
  onClose: () => void;
  onInsert: (summary: TPpmGitWorkSummary) => void;
};

export function WorkSummaryDialog(props: TWorkSummaryDialogProps) {
  if (!props.open) return null;
  return <WorkSummaryDialogBody {...props} />;
}

function WorkSummaryDialogBody({ workspaceId, projectId, onClose, onInsert }: TWorkSummaryDialogProps) {
  const ppmT = usePpmTranslation();
  const { controller, state } = useWorkSummaryController({ workspaceId, projectId });
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  return (
    <ModalCore
      isOpen
      handleClose={() => {
        if (shouldDismissPpmDialog({ reason: "backdrop", saving: false })) onClose();
        else lastFocusedRef.current?.focus();
      }}
      width={EModalWidth.XL}
    >
      <section
        className="max-h-[85vh] overflow-y-auto p-5"
        role="presentation"
        onFocus={(event) => {
          lastFocusedRef.current = event.target;
        }}
        onKeyDown={(event) => handlePpmDialogKeyDown(event, { saving: false, onClose })}
      >
        <div className="mb-5 flex items-center justify-between gap-3">
          <Dialog.Title as="h2" className="text-16 font-semibold text-primary">
            {ppmT("g23.summary.dialog_title")}
          </Dialog.Title>
          <button type="button" aria-label={ppmT("g23.summary.close")} onClick={onClose}>
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div className="mb-3 flex flex-wrap gap-1 rounded-md border border-subtle p-1">
          {PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              aria-pressed={state.preset === preset}
              className={`rounded-sm px-2 py-1 text-12 font-medium ${
                state.preset === preset ? "bg-layer-1 text-primary" : "text-secondary"
              }`}
              onClick={() => controller.setPreset(preset)}
            >
              {ppmT(PRESET_LABEL_KEYS[preset])}
            </button>
          ))}
        </div>

        {state.preset === "custom" && (
          <div className="mb-3 flex items-end gap-3">
            <label className="text-12 font-semibold text-secondary">
              {ppmT("g23.summary.from_label")}
              <input
                type="date"
                className="mt-1 block rounded-md border border-subtle bg-surface-2 px-2 py-1 text-13 text-primary"
                value={state.from}
                max={state.to || undefined}
                onChange={(event) => controller.setCustomRange(event.target.value, state.to)}
              />
            </label>
            <label className="text-12 font-semibold text-secondary">
              {ppmT("g23.summary.to_label")}
              <input
                type="date"
                className="mt-1 block rounded-md border border-subtle bg-surface-2 px-2 py-1 text-13 text-primary"
                value={state.to}
                min={state.from || undefined}
                onChange={(event) => controller.setCustomRange(state.from, event.target.value)}
              />
            </label>
          </div>
        )}

        {state.rangeError && (
          <p
            className="mb-3 rounded-lg border border-danger-subtle bg-danger-subtle p-3 text-12 text-primary"
            role="alert"
          >
            {state.rangeError}
          </p>
        )}
        {state.error && (
          <p
            className="mb-3 rounded-lg border border-danger-subtle bg-danger-subtle p-3 text-12 text-primary"
            role="alert"
          >
            {state.error}
          </p>
        )}

        {state.loading && (
          <p className="flex items-center gap-2 text-13 text-secondary">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            {ppmT("g23.summary.loading")}
          </p>
        )}

        {!state.loading && state.summary && <WorkSummaryPreview summary={state.summary} ppmT={ppmT} />}

        <div className="mt-4 flex justify-end gap-2 border-t border-subtle pt-4">
          <button
            type="button"
            className="rounded-md border border-subtle px-3 py-2 text-12 text-primary"
            onClick={onClose}
          >
            {ppmT("g23.summary.close")}
          </button>
          <button
            type="button"
            className="rounded-md bg-accent-primary px-3 py-2 text-12 font-semibold text-on-accent disabled:opacity-50"
            disabled={!state.summary || state.loading}
            onClick={() => {
              if (state.summary) onInsert(state.summary);
            }}
          >
            {ppmT("g23.summary.insert_action")}
          </button>
        </div>
      </section>
    </ModalCore>
  );
}

function WorkSummaryPreview({
  summary,
  ppmT,
}: {
  summary: TPpmGitWorkSummary;
  ppmT: (key: TPpmTranslationKey) => string;
}) {
  if (summary.items.length === 0) {
    return <p className="text-13 text-secondary">{ppmT("g23.summary.empty")}</p>;
  }
  return (
    <div>
      <p className="mb-2 text-11 font-semibold tracking-wide text-tertiary uppercase">
        {ppmT("g23.summary.preview_title")}
      </p>
      <div className="mb-4 grid grid-cols-5 gap-2">
        {(
          [
            ["g23.summary.totals_done", summary.totals.done],
            ["g23.summary.totals_in_progress", summary.totals.in_progress],
            ["g23.summary.totals_other", summary.totals.other],
            ["g23.summary.totals_commits", summary.totals.commits],
            ["g23.summary.totals_pull_requests", summary.totals.pull_requests],
          ] as const
        ).map(([key, value]) => (
          <div key={key} className="rounded-lg border border-subtle bg-layer-1 p-2 text-center">
            <p className="text-16 font-semibold text-primary">{value}</p>
            <p className="text-11 text-tertiary">{ppmT(key)}</p>
          </div>
        ))}
      </div>
      <ul className="grid max-h-64 gap-2 overflow-y-auto">
        {summary.items.map((item) => (
          <li key={item.work_item.id} className="rounded-md border border-subtle p-2">
            <p className="truncate text-13 text-primary">
              <span className="text-tertiary">{item.work_item.key}</span> {item.work_item.name}
            </p>
            <p className="text-11 text-tertiary">
              {item.work_item.state_name} · {item.commits.length} ·{" "}
              <GitPullRequest className="inline size-3" aria-hidden="true" /> {item.pull_requests.length}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export type TWorkSummaryButtonProps = {
  workspaceId: string;
  projectId: string | undefined;
  className?: string;
  onInsert: (summary: TPpmGitWorkSummary) => void;
};

export function WorkSummaryButton({ workspaceId, projectId, className, onInsert }: TWorkSummaryButtonProps) {
  const ppmT = usePpmTranslation();
  const [open, setOpen] = useState(false);
  if (!projectId) return null;
  return (
    <>
      <Tooltip tooltipContent={ppmT("g23.summary.button_label")}>
        <button
          type="button"
          aria-label={ppmT("g23.summary.button_label")}
          className={
            className ?? "grid aspect-square size-7 place-items-center rounded-xs text-placeholder hover:bg-layer-1"
          }
          onClick={() => setOpen(true)}
        >
          <GitPullRequest className="size-3.5" aria-hidden="true" />
        </button>
      </Tooltip>
      <WorkSummaryDialog
        open={open}
        workspaceId={workspaceId}
        projectId={projectId}
        onClose={() => setOpen(false)}
        onInsert={(summary) => {
          onInsert(summary);
          setOpen(false);
        }}
      />
    </>
  );
}
