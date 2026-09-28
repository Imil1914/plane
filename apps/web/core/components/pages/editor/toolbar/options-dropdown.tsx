/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo, useState } from "react";
import { observer } from "mobx-react";
import { ArrowUpToLine, Clipboard, History } from "lucide-react";
// plane imports
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { ToggleSwitch } from "@plane/ui";
// hooks
import { useAppRouter } from "@/hooks/use-app-router";
import { usePageFilters } from "@/hooks/use-page-filters";
import { useQueryParams } from "@/hooks/use-query-params";
// plane web imports
import type { TPageNavigationPaneTab } from "@/components/pages/navigation-pane/tab-panels";
import type { EPageStoreType } from "@/hooks/store";
// store
import type { TPageInstance } from "@/store/pages/base-page";
// local imports
import { PageActions } from "../../dropdowns";
import { ExportPageModal } from "../../modals/export-page-modal";
import { PAGE_NAVIGATION_PANE_TABS_QUERY_PARAM } from "../../navigation-pane";
import { usePpmText } from "@/hooks/use-ppm-text";

type Props = {
  page: TPageInstance;
  storeType: EPageStoreType;
};

export const PageOptionsDropdown = observer(function PageOptionsDropdown(props: Props) {
  const { page, storeType } = props;
  const ppmText = usePpmText();
  // states
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  // navigation
  const router = useAppRouter();
  // store values
  const {
    name,
    isContentEditable,
    editor: { editorRef },
  } = page;
  // page filters
  const { isFullWidth, handleFullWidth, isStickyToolbarEnabled, handleStickyToolbar } = usePageFilters();
  // query params
  const { updateQueryParams } = useQueryParams();
  // menu items list
  const EXTRA_MENU_OPTIONS = useMemo(
    function EXTRA_MENU_OPTIONS(): React.ComponentProps<typeof PageActions>["extraOptions"] {
      return [
        {
          key: "full-screen",
          action: () => handleFullWidth(!isFullWidth),
          customContent: (
            <>
              {ppmText("ui.page.full_width", "Full width")}
              <ToggleSwitch value={isFullWidth} onChange={() => {}} />
            </>
          ),
          className: "flex items-center justify-between gap-2",
        },
        {
          key: "sticky-toolbar",
          action: () => handleStickyToolbar(!isStickyToolbarEnabled),
          customContent: (
            <>
              {ppmText("ui.page.sticky_toolbar", "Sticky toolbar")}
              <ToggleSwitch value={isStickyToolbarEnabled} onChange={() => {}} />
            </>
          ),
          className: "flex items-center justify-between gap-2",
          shouldRender: isContentEditable,
        },
        {
          key: "copy-markdown",
          action: () => {
            if (!editorRef) return;
            editorRef.copyMarkdownToClipboard();
            setToast({
              type: TOAST_TYPE.SUCCESS,
              title: ppmText("ui.toast.success", "Success!"),
              message: ppmText("ui.page.markdown_copied", "Markdown copied to clipboard."),
            });
          },
          title: ppmText("ui.page.copy_markdown", "Copy markdown"),
          icon: Clipboard,
          shouldRender: true,
        },
        {
          key: "version-history",
          action: () => {
            // update query param to show info tab in navigation pane
            const updatedRoute = updateQueryParams({
              paramsToAdd: {
                [PAGE_NAVIGATION_PANE_TABS_QUERY_PARAM]: "info" satisfies TPageNavigationPaneTab,
              },
            });
            router.push(updatedRoute);
          },
          title: ppmText("ui.page.version_history", "Version history"),
          icon: History,
          shouldRender: true,
        },
        {
          key: "export",
          action: () => setIsExportModalOpen(true),
          title: ppmText("ui.page.export", "Export"),
          icon: ArrowUpToLine,
          shouldRender: true,
        },
      ];
    },
    [
      handleFullWidth,
      isFullWidth,
      handleStickyToolbar,
      isStickyToolbarEnabled,
      isContentEditable,
      editorRef,
      updateQueryParams,
      router,
      setIsExportModalOpen,
      ppmText,
    ]
  );

  return (
    <>
      <ExportPageModal
        editorRef={editorRef}
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        pageTitle={name ?? ""}
      />
      <PageActions
        extraOptions={EXTRA_MENU_OPTIONS}
        optionsOrder={[
          "full-screen",
          "sticky-toolbar",
          "copy-markdown",
          "version-history",
          "make-a-copy",
          "archive-restore",
          "delete",
          "toggle-access",
          "export",
        ]}
        page={page}
        storeType={storeType}
      />
    </>
  );
});
