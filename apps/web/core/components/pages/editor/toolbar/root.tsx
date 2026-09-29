/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { PanelRight } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Tooltip } from "@plane/propel/tooltip";
import { cn } from "@plane/utils";
// components
import { PageToolbar } from "@/components/pages/editor/toolbar";
// G2.3 (line G-Web): «Вставить коммит/PR» и «Что сделано за период» — buttons next to the pages formatting toolbar
// (the "/" item «Коммит или PR» is registered separately, see editor-body.tsx's InsertGitObjectSlashHost).
import { buildGitObjectHtmlLink } from "@/components/ppm-git/insert/format";
import { InsertGitObjectButton } from "@/components/ppm-git/insert/insert-git-object-dialog";
import { WorkSummaryButton } from "@/components/ppm-git/insert/work-summary-dialog";
// hooks
import { usePageFilters } from "@/hooks/use-page-filters";
import { useWorkspace } from "@/hooks/store/use-workspace";
// store
import type { TPageInstance } from "@/store/pages/base-page";

type Props = {
  handleOpenNavigationPane: () => void;
  isNavigationPaneOpen: boolean;
  page: TPageInstance;
  projectId?: string;
  workspaceSlug: string;
};

export const PageEditorToolbarRoot = observer(function PageEditorToolbarRoot(props: Props) {
  const { handleOpenNavigationPane, isNavigationPaneOpen, page, projectId, workspaceSlug } = props;
  // translation
  const { t } = useTranslation();
  // derived values
  const {
    isContentEditable,
    editor: { editorRef },
  } = page;
  // G2.3 (line G-Web): the Git-object/work-summary services take the workspace id, not its slug.
  const { getWorkspaceBySlug } = useWorkspace();
  const workspaceId = getWorkspaceBySlug(workspaceSlug)?.id;
  // page filters
  const { isFullWidth, isStickyToolbarEnabled } = usePageFilters();
  // derived values
  const shouldHideToolbar = !isStickyToolbarEnabled || !isContentEditable;

  return (
    <>
      <div
        id="page-toolbar-container"
        className={cn("max-h-[52px] overflow-auto transition-all duration-300 ease-linear", {
          "max-h-0 overflow-hidden": shouldHideToolbar,
        })}
      >
        <div
          className={cn(
            "page-toolbar-content relative hidden min-h-[52px] items-center px-page-x transition-all duration-200 ease-in-out md:flex",
            {
              "wide-layout": isFullWidth,
            }
          )}
        >
          <div className="flex w-full max-w-full items-center justify-between">
            <div className="flex flex-1 items-center gap-1">
              {editorRef && <PageToolbar editorRef={editorRef} />}
              {editorRef && workspaceId && (
                <>
                  <InsertGitObjectButton
                    workspaceId={workspaceId}
                    projectId={projectId}
                    onInsert={({ label, url }) =>
                      editorRef.setEditorValueAtCursorPosition(buildGitObjectHtmlLink(label, url))
                    }
                  />
                  <WorkSummaryButton
                    workspaceId={workspaceId}
                    projectId={projectId}
                    onInsert={(summary) => editorRef.setEditorValueAtCursorPosition(summary.html)}
                  />
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              {!isNavigationPaneOpen && (
                <button
                  type="button"
                  className="grid size-6 shrink-0 place-items-center rounded-sm text-secondary transition-colors hover:bg-layer-transparent-hover hover:text-primary"
                  onClick={handleOpenNavigationPane}
                >
                  <PanelRight className="size-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      {shouldHideToolbar && (
        <div className="absolute top-0 right-0 z-10 flex h-[52px] items-center px-page-x">
          {!isNavigationPaneOpen && (
            <Tooltip tooltipContent={t("page_navigation_pane.open_button")}>
              <button
                type="button"
                className="grid size-6 shrink-0 place-items-center rounded-sm text-secondary transition-colors hover:bg-layer-transparent-hover hover:text-primary"
                onClick={handleOpenNavigationPane}
                aria-label={t("page_navigation_pane.open_button")}
              >
                <PanelRight className="size-3.5" />
              </button>
            </Tooltip>
          )}
        </div>
      )}
    </>
  );
});
