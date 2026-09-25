/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import { useParams } from "next/navigation";
import { CircleDashed } from "lucide-react";
import { ChevronRightIcon, PlusIcon } from "@plane/propel/icons";
// types
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import type { TIssue, ISearchIssueResponse, TIssueGroupByOptions } from "@plane/types";
// ui
import { CustomMenu } from "@plane/ui";
// components
import { cn } from "@plane/utils";
import { ExistingIssuesListModal } from "@/components/core/modals/existing-issues-list-modal";
import { MultipleSelectGroupAction } from "@/components/core/multiple-select";
import { CreateUpdateIssueModal } from "@/components/issues/issue-modal/modal";
import { CreateUpdateEpicModal } from "@/components/epic-modal";
// constants
import { useIssueStoreType } from "@/hooks/use-issue-layout-store";
import type { TSelectionHelper } from "@/hooks/use-multiple-select";
import { formatPpmTemplate } from "@/components/ppm-tasks/format";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { usePpmDesignV2 } from "@/lib/ppm-design";

interface IHeaderGroupByCard {
  groupID: string;
  groupBy: TIssueGroupByOptions;
  icon?: React.ReactNode;
  title: string;
  count: number;
  issuePayload: Partial<TIssue>;
  canEditProperties: (projectId: string | undefined) => boolean;
  disableIssueCreation?: boolean;
  addIssuesToView?: (issueIds: string[]) => Promise<TIssue>;
  selectionHelpers: TSelectionHelper;
  handleCollapsedGroups: (value: string) => void;
  isEpic?: boolean;
  isExpanded?: boolean;
  ppmEmptyHint?: string;
}

export const HeaderGroupByCard = observer(function HeaderGroupByCard(props: IHeaderGroupByCard) {
  const {
    groupID,
    icon,
    title,
    count,
    issuePayload,
    canEditProperties,
    disableIssueCreation,
    addIssuesToView,
    selectionHelpers,
    handleCollapsedGroups,
    isEpic = false,
    isExpanded,
    ppmEmptyHint,
  } = props;
  // states
  const [isOpen, setIsOpen] = useState(false);
  const [openExistingIssueListModal, setOpenExistingIssueListModal] = useState(false);
  // router
  const { workspaceSlug, projectId, moduleId, cycleId } = useParams();
  const storeType = useIssueStoreType();
  // derived values
  const renderExistingIssueModal = moduleId || cycleId;
  const existingIssuesListModalPayload = moduleId ? { module: moduleId.toString() } : { cycle: true };
  const isGroupSelectionEmpty = selectionHelpers.isGroupSelected(groupID) === "empty";
  // auth
  const canSelectIssues = canEditProperties(projectId?.toString()) && !selectionHelpers.isSelectionDisabled;
  const isDesignV2 = usePpmDesignV2();
  const ppmT = usePpmTranslation();
  const addInGroupLabel = formatPpmTemplate(ppmT("tasks.group.add_in_group"), { group: title });
  const groupIcon = icon ?? <CircleDashed className="size-3.5" strokeWidth={2} />;

  const handleAddIssuesToView = async (data: ISearchIssueResponse[]) => {
    if (!workspaceSlug || !projectId) return;

    const issues = data.map((i) => i.id);

    try {
      await addIssuesToView?.(issues);

      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: "Success!",
        message: "Work items added to the cycle successfully.",
      });
    } catch (_error) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "Error!",
        message: "Selected work items could not be added to the cycle. Please try again.",
      });
    }
  };

  return (
    <>
      <div
        className={
          isDesignV2
            ? "group/list-header flex w-full flex-shrink-0 items-center gap-2"
            : "group/list-header flex w-full flex-shrink-0 items-center gap-2 py-1.5"
        }
      >
        {canSelectIssues && (
          <div className="absolute left-1 flex w-3.5 flex-shrink-0 items-center">
            <MultipleSelectGroupAction
              className={cn(
                "pointer-events-none size-3.5 opacity-0 !outline-none group-hover/list-header:pointer-events-auto group-hover/list-header:opacity-100",
                {
                  "pointer-events-auto opacity-100": !isGroupSelectionEmpty,
                }
              )}
              groupID={groupID}
              selectionHelpers={selectionHelpers}
              disabled={count === 0}
            />
          </div>
        )}
        {!isDesignV2 && <div className="grid flex-shrink-0 place-items-center overflow-hidden">{groupIcon}</div>}

        {isDesignV2 ? (
          <>
            {isExpanded === undefined ? (
              <div className="flex min-w-0 items-center gap-2">
                <span className="grid flex-shrink-0 place-items-center">{groupIcon}</span>
                <span className="ppm-text-title-3 truncate text-primary">{title}</span>
                <span className="font-code text-12 text-tertiary tabular-nums">{count || 0}</span>
              </div>
            ) : (
              <button
                type="button"
                aria-expanded={isExpanded}
                onClick={() => handleCollapsedGroups(groupID)}
                className="flex min-w-0 items-center gap-2 rounded-md pr-1.5 text-left"
              >
                <ChevronRightIcon
                  aria-hidden="true"
                  className={
                    isExpanded
                      ? "size-3.5 flex-shrink-0 rotate-90 text-tertiary transition-transform"
                      : "size-3.5 flex-shrink-0 text-tertiary transition-transform"
                  }
                />
                <span className="grid flex-shrink-0 place-items-center">{groupIcon}</span>
                <span className="ppm-text-title-3 truncate text-primary">{title}</span>
                <span className="font-code text-12 text-tertiary tabular-nums">{count || 0}</span>
              </button>
            )}
            {ppmEmptyHint && <span className="truncate text-12 text-tertiary">{ppmEmptyHint}</span>}
            <span aria-hidden="true" className="flex-1" />
          </>
        ) : (
          <>
            {/* eslint-disable-next-line jsx_a11y/click-events-have-key-events eslint-disable-next-line jsx_a11y/no-static-element-interactions */}
            <div
              className="relative flex w-full cursor-pointer flex-row items-center gap-1 overflow-hidden"
              onClick={() => handleCollapsedGroups(groupID)}
            >
              <div className="line-clamp-1 inline-block truncate font-medium text-primary">{title}</div>
              <div className="pl-2 text-13 font-medium text-tertiary">{count || 0}</div>
              <div className="px-2.5"></div>
            </div>
          </>
        )}

        {!disableIssueCreation &&
          (renderExistingIssueModal ? (
            <CustomMenu
              customButton={
                <span className="flex h-5 w-5 flex-shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-xs transition-all hover:bg-layer-1">
                  <PlusIcon className="h-3.5 w-3.5" strokeWidth={2} />
                </span>
              }
            >
              <CustomMenu.MenuItem
                onClick={() => {
                  setIsOpen(true);
                }}
              >
                <span className="flex items-center justify-start gap-2">
                  {isDesignV2 ? ppmT("tasks.group.create_task") : "Create work item"}
                </span>
              </CustomMenu.MenuItem>
              <CustomMenu.MenuItem
                onClick={() => {
                  setOpenExistingIssueListModal(true);
                }}
              >
                <span className="flex items-center justify-start gap-2">
                  {isDesignV2 ? ppmT("tasks.group.add_existing") : "Add an existing work item"}
                </span>
              </CustomMenu.MenuItem>
            </CustomMenu>
          ) : isDesignV2 ? (
            <button
              type="button"
              aria-label={addInGroupLabel}
              title={addInGroupLabel}
              onClick={() => setIsOpen(true)}
              className="grid size-6 flex-shrink-0 place-items-center rounded-md text-tertiary hover:bg-layer-1-hover hover:text-secondary"
            >
              <PlusIcon aria-hidden="true" width={14} strokeWidth={2} />
            </button>
          ) : (
            // oxlint-disable-next-line jsx_a11y/click-events-have-key-events oxlint-disable-next-line jsx_a11y/no-static-element-interactions
            <div
              className="flex h-5 w-5 flex-shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-xs transition-all hover:bg-layer-1"
              onClick={() => {
                setIsOpen(true);
              }}
            >
              <PlusIcon width={14} strokeWidth={2} />
            </div>
          ))}

        {isEpic ? (
          <CreateUpdateEpicModal isOpen={isOpen} onClose={() => setIsOpen(false)} data={issuePayload} />
        ) : (
          <CreateUpdateIssueModal
            isOpen={isOpen}
            onClose={() => setIsOpen(false)}
            data={issuePayload}
            storeType={storeType}
          />
        )}

        {renderExistingIssueModal && (
          <ExistingIssuesListModal
            workspaceSlug={workspaceSlug?.toString()}
            projectId={projectId?.toString()}
            isOpen={openExistingIssueListModal}
            handleClose={() => setOpenExistingIssueListModal(false)}
            searchParams={existingIssuesListModalPayload}
            handleOnSubmit={handleAddIssuesToView}
          />
        )}
      </div>
    </>
  );
});
