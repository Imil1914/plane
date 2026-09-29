// G2.3 (line G-Web, G3): the «Вставить коммит/PR» dialog — search with a typing-pause delay, an «Все/Коммиты/PR»
// filter, a keyboard-navigable result list, and the two empty states from the G2.3 card / Review Focus item 5. The
// state machine (`insert-git-object-picker.ts`) is DOM-free and unit-tested on its own; this file is the thin React
// wiring around it, following the same shape as `useForgejoRepositoryPicker`/`ForgejoRepositoryPickerView`
// (forgejo-connect.tsx) — `useSyncExternalStore` over a picker created once per open dialog.
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Tooltip } from "@plane/propel/tooltip";
import { Dialog } from "@headlessui/react";
import { GitCommitHorizontal, LoaderCircle, Search, X } from "lucide-react";
import { EModalWidth, ModalCore } from "@plane/ui";
import { handlePpmDialogKeyDown, shouldDismissPpmDialog } from "@/helpers/ppm-dialog-dismiss.helper";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { PpmGitService, type TPpmGitSearchObject } from "@/services/ppm-git.service";
import { formatGitObjectSubtitle } from "./format";
import {
  classifyGitObjectEmptyState,
  createInsertGitObjectPicker,
  type TGitObjectFilter,
  type TInsertGitObjectPicker,
  type TInsertGitObjectPickerState,
} from "./insert-git-object-picker";

const gitService = new PpmGitService();

export type TInsertGitObjectPayload = { label: string; url: string };

type TDeps = {
  workspaceId: string;
  projectId: string;
};

/** One picker per open dialog: starts the default listing on open, stops listening on close (a late answer to a
 * closed dialog is dropped by the picker's own generation guard). */
function useInsertGitObjectPicker(deps: TDeps): { picker: TInsertGitObjectPicker; state: TInsertGitObjectPickerState } {
  const depsRef = useRef(deps);
  useEffect(() => {
    depsRef.current = deps;
  });
  const [picker] = useState(() =>
    createInsertGitObjectPicker({
      search: async ({ q, type, limit }) => {
        const { workspaceId, projectId } = depsRef.current;
        const response = await gitService.searchGitObjects(workspaceId, projectId, { q, type, limit });
        return response.results;
      },
      // Review round 2 (#2): the search contract has no "are any repositories connected" field of its own — the
      // "Код" overview is the only existing source, so it is reused here purely to tell the two empty states apart.
      checkHasRepositories: async () => {
        const { workspaceId, projectId } = depsRef.current;
        const overview = await gitService.getOverview(workspaceId, projectId);
        return overview.repositories.some((repository) => repository.status === "active");
      },
    })
  );
  const state = useSyncExternalStore(picker.subscribe, picker.getState, picker.getState);
  useEffect(() => {
    picker.start();
    return () => picker.dispose();
  }, [picker]);
  return { picker, state };
}

const FILTERS: TGitObjectFilter[] = ["all", "commit", "pull_request"];

function filterLabelKey(
  filter: TGitObjectFilter
): "g23.insert.filter_all" | "g23.insert.filter_commit" | "g23.insert.filter_pull_request" {
  if (filter === "commit") return "g23.insert.filter_commit";
  if (filter === "pull_request") return "g23.insert.filter_pull_request";
  return "g23.insert.filter_all";
}

export type TInsertGitObjectDialogProps = {
  open: boolean;
  workspaceId: string;
  projectId: string;
  onClose: () => void;
  onInsert: (payload: TInsertGitObjectPayload) => void;
};

export function InsertGitObjectDialog(props: TInsertGitObjectDialogProps) {
  if (!props.open) return null;
  return <InsertGitObjectDialogBody {...props} />;
}

function InsertGitObjectDialogBody({ workspaceId, projectId, onClose, onInsert }: TInsertGitObjectDialogProps) {
  const ppmT = usePpmTranslation();
  const { picker, state } = useInsertGitObjectPicker({ workspaceId, projectId });
  const searchRef = useRef<HTMLInputElement>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const select = (item: TPpmGitSearchObject | undefined) => {
    if (!item) return;
    onInsert({ label: item.label, url: item.canonical_url });
    onClose();
  };

  const onListKeyDown = (event: ReactKeyboardEvent) => {
    if (event.code === "ArrowDown") {
      event.preventDefault();
      picker.moveHighlight(1);
    } else if (event.code === "ArrowUp") {
      event.preventDefault();
      picker.moveHighlight(-1);
    } else if (event.code === "Enter") {
      event.preventDefault();
      select(picker.selectHighlighted());
    }
  };

  const emptyStateKind = classifyGitObjectEmptyState(state.appliedQuery, state.items.length, state.hasRepositories);

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
            {ppmT("g23.insert.dialog_title")}
          </Dialog.Title>
          <button type="button" aria-label={ppmT("g23.insert.close")} onClick={onClose}>
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div className="mb-3 flex gap-1 rounded-md border border-subtle p-1">
          {FILTERS.map((filter) => (
            <button
              key={filter}
              type="button"
              aria-pressed={state.filter === filter}
              className={`flex-1 rounded-sm px-2 py-1 text-12 font-medium ${
                state.filter === filter ? "bg-layer-1 text-primary" : "text-secondary"
              }`}
              onClick={() => picker.setFilter(filter)}
            >
              {ppmT(filterLabelKey(filter))}
            </button>
          ))}
        </div>

        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-tertiary"
            aria-hidden="true"
          />
          <input
            ref={searchRef}
            className="w-full rounded-md border border-subtle bg-surface-2 py-2 pr-9 pl-9 text-13 text-primary outline-none focus:border-accent-strong"
            autoComplete="off"
            spellCheck={false}
            placeholder={ppmT("g23.insert.search_placeholder")}
            value={state.query}
            onChange={(event) => picker.setQuery(event.target.value)}
            onKeyDown={onListKeyDown}
            role="combobox"
            aria-expanded={state.items.length > 0}
            aria-controls="ppm-g23-insert-list"
          />
          {state.loading && (
            <LoaderCircle
              className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-tertiary"
              aria-hidden="true"
            />
          )}
        </div>

        {state.error && (
          <p
            className="mt-3 rounded-lg border border-danger-subtle bg-danger-subtle p-3 text-12 text-primary"
            role="alert"
          >
            {state.error}
          </p>
        )}

        {!state.error && !state.loading && emptyStateKind !== "none" && (
          <p className="mt-4 text-13 text-secondary">
            {emptyStateKind === "no_repositories" && ppmT("g23.insert.empty_no_repositories")}
            {emptyStateKind === "no_objects" && ppmT("g23.insert.empty_no_objects")}
            {emptyStateKind === "not_found" && ppmT("g23.insert.empty_not_found")}
          </p>
        )}

        <ul id="ppm-g23-insert-list" role="listbox" className="mt-3 grid gap-1">
          {state.items.map((item, index) => (
            <li key={item.id}>
              <button
                type="button"
                role="option"
                aria-selected={index === state.highlightedIndex}
                className={`flex w-full items-start gap-2 rounded-md px-3 py-2 text-left ${
                  index === state.highlightedIndex ? "bg-layer-1" : "hover:bg-layer-1"
                }`}
                onMouseEnter={() => picker.setHighlightedIndex(index)}
                onClick={() => select(item)}
              >
                <GitCommitHorizontal className="mt-0.5 size-4 shrink-0 text-tertiary" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block truncate text-13 text-primary">{item.label}</span>
                  <span className="block truncate text-11 text-tertiary">
                    {formatGitObjectSubtitle(item.ref, item.provider_updated_at ?? item.last_seen_at)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </ModalCore>
  );
}

export type TInsertGitObjectButtonProps = {
  workspaceId: string;
  projectId: string | undefined;
  className?: string;
  /** Reads the live editor imperatively, only when the user actually inserts — avoids depending on a resolved
   * `EditorRefApi` at render time (the editor may still be mounting). */
  onInsert: (payload: TInsertGitObjectPayload) => void;
};

/** The toolbar button used next to the comment/description/page formatting toolbars (research §5) and, with a
 * markdown `onInsert`, in the Vault note editor. Owns its own open state — every call site gets an independent
 * dialog instance. */
export function InsertGitObjectButton({ workspaceId, projectId, className, onInsert }: TInsertGitObjectButtonProps) {
  const ppmT = usePpmTranslation();
  const [open, setOpen] = useState(false);
  if (!projectId) return null;
  return (
    <>
      <Tooltip tooltipContent={ppmT("g23.insert.button_label")}>
        <button
          type="button"
          aria-label={ppmT("g23.insert.button_label")}
          className={
            className ?? "grid aspect-square size-7 place-items-center rounded-xs text-placeholder hover:bg-layer-1"
          }
          onClick={() => setOpen(true)}
        >
          <GitCommitHorizontal className="size-3.5" aria-hidden="true" />
        </button>
      </Tooltip>
      <InsertGitObjectDialog
        open={open}
        workspaceId={workspaceId}
        projectId={projectId}
        onClose={() => setOpen(false)}
        onInsert={onInsert}
      />
    </>
  );
}
