/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useParams } from "next/navigation";
// constants
import { SPREADSHEET_SELECT_GROUP } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
// ui
import type { IIssueDisplayFilterOptions, IIssueDisplayProperties } from "@plane/types";
// components
import { cn } from "@plane/utils";
import { isPpmShellEnabled } from "@ppm/brand";
import { MultipleSelectGroupAction } from "@/components/core/multiple-select";
// hooks
import type { TSelectionHelper } from "@/hooks/use-multiple-select";
import { SpreadsheetHeaderColumn } from "./spreadsheet-header-column";

interface Props {
  displayProperties: IIssueDisplayProperties;
  displayFilters: IIssueDisplayFilterOptions;
  handleDisplayFilterUpdate: (data: Partial<IIssueDisplayFilterOptions>) => void;
  canEditProperties: (projectId: string | undefined) => boolean;
  isEstimateEnabled: boolean;
  spreadsheetColumnsList: (keyof IIssueDisplayProperties)[];
  selectionHelpers: TSelectionHelper;
  isEpic?: boolean;
}

export const SpreadsheetHeader = observer(function SpreadsheetHeader(props: Props) {
  const {
    displayProperties,
    displayFilters,
    handleDisplayFilterUpdate,
    canEditProperties,
    isEstimateEnabled,
    spreadsheetColumnsList,
    selectionHelpers,
    isEpic = false,
  } = props;
  // router
  const { projectId } = useParams();
  const { t } = useTranslation();
  // derived values
  const isGroupSelectionEmpty = selectionHelpers.isGroupSelected(SPREADSHEET_SELECT_GROUP) === "empty";
  const isPpmShell = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);
  // auth
  // PPM (линия B): в видах пространства проекта в адресе нет — флажок шапки выделяет только задачи с флажком строки.
  const canSelectIssues =
    !selectionHelpers.isSelectionDisabled && (projectId ? canEditProperties(projectId.toString()) : true);

  return (
    <thead className="sticky top-0 left-0 z-[12] border-b-[0.5px] border-subtle">
      <tr>
        {/* Single header column containing both identifier and workitem */}
        <th
          className="group/list-header left-0 z-[15] h-11 min-w-60 border-r-[0.5px] border-subtle bg-layer-1 text-13 font-medium md:sticky"
          tabIndex={-1}
        >
          <div className="flex h-full w-full items-center gap-2 px-page-x">
            {/* Workitem header section */}
            <div className="flex h-full min-w-80 flex-grow items-center gap-1 py-2.5">
              {canSelectIssues && (
                <div className="mr-1 flex w-3.5 flex-shrink-0 items-center">
                  <MultipleSelectGroupAction
                    className={cn(
                      "pointer-events-none size-3.5 opacity-0 !outline-none group-hover/list-header:pointer-events-auto group-hover/list-header:opacity-100 focus-visible:opacity-100",
                      {
                        "pointer-events-auto opacity-100": !isGroupSelectionEmpty || selectionHelpers.isSelectionActive,
                      }
                    )}
                    groupID={SPREADSHEET_SELECT_GROUP}
                    selectionHelpers={selectionHelpers}
                  />
                </div>
              )}
              <span className="text-13 font-medium">
                {isEpic ? "Epics" : isPpmShell ? t("work_items") : "Work items"}
              </span>
            </div>
          </div>
        </th>

        {spreadsheetColumnsList.map((property) => (
          <SpreadsheetHeaderColumn
            key={property}
            property={property}
            displayProperties={displayProperties}
            displayFilters={displayFilters}
            handleDisplayFilterUpdate={handleDisplayFilterUpdate}
            isEstimateEnabled={isEstimateEnabled}
            isEpic={isEpic}
          />
        ))}
      </tr>
    </thead>
  );
});
