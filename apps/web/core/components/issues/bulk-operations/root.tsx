/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Линия B (просьба владельца 2026-09-28): панель массовых действий вместо рекламы платной версии. Контейнер только
// подключает сторы: что доступно — bulk-actions.ts, что делать по нажатию — bulk-flow.ts (раунд 3: логика вне React,
// с тестами поведения). Удаление — по одной задаче тем же действием, что и обычный диалог удаления (история,
// уведомления, вебхуки, права — как при обычном удалении), статус и исполнитель — по одной, спринт — массовым переносом
// стора, «Без спринта» — по одной; по одной — не больше 5 запросов сразу.
import { useEffect, useSyncExternalStore } from "react";
import { observer } from "mobx-react";
import { useParams } from "next/navigation";
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { CycleGroupIcon, CycleIcon, StateGroupIcon, UserCirclePropertyIcon } from "@plane/propel/icons";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { Avatar } from "@plane/ui";
import { getFileURL } from "@plane/utils";
import type { TPpmTranslationKey } from "@ppm/brand";
// components
import { formatPpmTemplate } from "@/components/ppm-tasks/format";
// hooks
import { useCycle } from "@/hooks/store/use-cycle";
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { useIssues } from "@/hooks/store/use-issues";
import { useMember } from "@/hooks/store/use-member";
import { useMultipleSelectStore } from "@/hooks/store/use-multiple-select-store";
import { useProject } from "@/hooks/store/use-project";
import { useProjectState } from "@/hooks/store/use-project-state";
import { useUser, useUserPermissions } from "@/hooks/store/user";
import { useIssueStoreType } from "@/hooks/use-issue-layout-store";
import { useIssuesActions } from "@/hooks/use-issues-actions";
import type { TEntityDetails, TSelectionHelper } from "@/hooks/use-multiple-select";
import { getPpmEntitiesToAdd, isPpmSelectionKeyTargetIgnored } from "@/hooks/use-multiple-select-helpers";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { getPpmStateDisplayName, usePpmDesignV2 } from "@/lib/ppm-design";
import type { IProjectIssues } from "@/store/issue/project";
// local imports
import { PpmBulkActionBarView } from "./action-bar";
import {
  canPpmDeleteIssue,
  formatPpmBulkCount,
  getPpmBulkAvailability,
  getPpmBulkSprintOptions,
  intersectPpmMemberIds,
  ppmBulkRunGuard,
  PPM_BULK_NONE,
} from "./bulk-actions";
import type { TPpmBulkIssue, TPpmBulkSprintPhase, TPpmBulkToast } from "./bulk-actions";
import { runPpmBulkDeleteFlow, runPpmBulkUpdateFlow } from "./bulk-flow";
import type { TPpmBulkDeleteIO, TPpmBulkFlowIO, TPpmBulkUpdateCommand, TPpmBulkUpdateIO } from "./bulk-flow";
import { PpmBulkPicker } from "./bulk-picker";
import type { TPpmBulkPickerOption } from "./bulk-picker";
import { usePpmBulkDeleteConfirm } from "./delete-confirm";

type Props = {
  className?: string;
  selectionHelpers: TSelectionHelper;
};

/**
 * Методы стора списка, которыми пользуется панель. Панель включена только для сторов задач проекта, спринта,
 * направления, вида, профиля («Мои задачи») и видов пространства — все они наследуют эти методы BaseIssuesStore.
 * Удаление идёт не через стор напрямую, а через useIssuesActions — как у обычного диалога удаления в этих списках.
 */
type TPpmBulkIssueStore = Pick<
  IProjectIssues,
  "updateIssue" | "addIssueToCycle" | "removeCycleFromIssue" | "removeIssueFromList"
> & {
  fetchParentStats?: (workspaceSlug: string, projectId?: string) => unknown;
};

const TOAST_TYPES: Record<TPpmBulkToast["type"], TOAST_TYPE> = {
  success: TOAST_TYPE.SUCCESS,
  warning: TOAST_TYPE.WARNING,
  error: TOAST_TYPE.ERROR,
};

const SPRINT_PHASE_KEYS: Record<TPpmBulkSprintPhase, TPpmTranslationKey> = {
  current: "bulk.sprint_phase_current",
  upcoming: "bulk.sprint_phase_upcoming",
  draft: "bulk.sprint_phase_draft",
};

const useIsPpmBulkBusy = () => useSyncExternalStore(ppmBulkRunGuard.subscribe, ppmBulkRunGuard.isBusy, () => false);

/** Одно значение у всех выделенных задач, иначе undefined. */
function commonValue<T>(values: readonly T[]): T | undefined {
  return values.length > 0 && values.every((value) => value === values[0]) ? values[0] : undefined;
}

/** Исполнитель, общий для всех выделенных задач (ровно один или «Без исполнителя»), — для галочки в меню. */
function getCommonAssignee(issues: readonly TPpmBulkIssue[]): string | undefined {
  const first = issues[0]?.assigneeIds;
  if (!first || first.length > 1) return undefined;
  const same = issues.every(
    (issue) => issue.assigneeIds.length === first.length && first.every((id) => issue.assigneeIds.includes(id))
  );
  if (!same) return undefined;
  return first.length === 0 ? PPM_BULK_NONE : first[0];
}

export const IssueBulkOperationsRoot = observer(function IssueBulkOperationsRoot(props: Props) {
  const { className, selectionHelpers } = props;
  // store hooks
  const { isSelectionActive } = useMultipleSelectStore();
  const isBusy = useIsPpmBulkBusy();

  // Пока действие идёт, панель остаётся на экране, даже если удалённые задачи уже ушли из выделения.
  if (selectionHelpers.isSelectionDisabled || (!isSelectionActive && !isBusy)) return null;

  return <PpmBulkActionBar className={className} selectionHelpers={selectionHelpers} />;
});

const PpmBulkActionBar = observer(function PpmBulkActionBar(props: Props) {
  const { className, selectionHelpers } = props;
  // router
  const { workspaceSlug: routerWorkspaceSlug } = useParams();
  const workspaceSlug = routerWorkspaceSlug?.toString() ?? "";
  // store hooks
  const storeType = useIssueStoreType();
  const { issues } = useIssues(storeType);
  // То же действие, что списки передают обычному диалогу удаления: handleDelete = removeIssue(project_id, id).
  const { removeIssue } = useIssuesActions(storeType);
  const { issueMap } = useIssues();
  const { selectedEntityIds, getEntityDetailsFromEntityID, getIsEntitySelected, bulkUpdateSelectedEntityDetails } =
    useMultipleSelectStore();
  const { allowPermissions } = useUserPermissions();
  const { data: currentUser } = useUser();
  const { getProjectById, getProjectIdentifierById } = useProject();
  const { getProjectStateIds, getStateById, fetchProjectStates } = useProjectState();
  const {
    getUserDetails,
    project: { getProjectMemberIds, fetchProjectMembers },
  } = useMember();
  const { getProjectCycleDetails, fetchAllCycles } = useCycle();
  const { peekIssue } = useIssueDetail();
  // translation and look
  const { currentLocale } = useTranslation();
  const ppmT = usePpmTranslation();
  const isDesignV2 = usePpmDesignV2();
  const { confirm, confirmDialog } = usePpmBulkDeleteConfirm();
  const isBusy = useIsPpmBulkBusy();
  // derived values
  const store = issues as unknown as TPpmBulkIssueStore;
  const clearSelection = selectionHelpers.handleClearSelection;
  const isPeekOpen = !!peekIssue;

  // Esc снимает выделение — если не идёт действие, не открыта карточка задачи и фокус не в поле, меню или диалоге
  // (там Esc закрывает своё).
  useEffect(() => {
    if (isBusy || isPeekOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isPpmSelectionKeyTargetIgnored(event.target)) return;
      clearSelection();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [clearSelection, isBusy, isPeekOpen]);

  // Каждая задача один раз: при группировке по исполнителю, метке или направлению она стоит в нескольких группах.
  const selectedIds = [...new Set(selectedEntityIds)];
  const selection = selectedIds
    .map((issueId) => getEntityDetailsFromEntityID(issueId))
    .filter((entity): entity is TEntityDetails => !!entity);
  const selectedIssues: TPpmBulkIssue[] = selectedIds.flatMap((issueId) => {
    const issue = issueMap[issueId];
    if (!issue) return [];
    const identifier = issue.project_id ? getProjectIdentifierById(issue.project_id) : "";
    return [
      {
        id: issue.id,
        projectId: issue.project_id ?? null,
        label: identifier && issue.sequence_id ? `${identifier}-${issue.sequence_id}` : issue.name,
        stateId: issue.state_id ?? null,
        assigneeIds: issue.assignee_ids ?? [],
        cycleId: issue.cycle_id ?? null,
        createdBy: issue.created_by ?? null,
        parentId: issue.parent_id ?? null,
        subIssuesCount: issue.sub_issues_count ?? 0,
      },
    ];
  });
  // Родитель невыделенной задачи — из данных списка; неизвестен — undefined.
  const getParentId = (issueId: string) => (issueMap[issueId] ? (issueMap[issueId].parent_id ?? null) : undefined);

  // Права — как у обычного диалога удаления (issues/delete-issue-modal.tsx): автор задачи или администратор проекта.
  const isProjectAdmin = (projectId: string) =>
    allowPermissions([EUserPermissions.ADMIN], EUserPermissionsLevel.PROJECT, workspaceSlug, projectId);
  const rights = { currentUserId: currentUser?.id, isProjectAdmin };
  const availability = getPpmBulkAvailability(selectedIssues, {
    canDelete: (issue) => canPpmDeleteIssue(issue, rights),
    getParentId,
    isSprintEnabled: (projectId) => !!getProjectById(projectId)?.cycle_view,
  });
  const { singleProjectId, projectIds } = availability;
  const hintOf = (key: TPpmTranslationKey | null) => (key ? ppmT(key) : null);

  // ---------------- варианты меню ----------------
  const commonStateId = commonValue(selectedIssues.map((issue) => issue.stateId));
  const stateIds = singleProjectId ? getProjectStateIds(singleProjectId) : undefined;
  const statusOptions: TPpmBulkPickerOption[] | undefined = stateIds?.flatMap((stateId) => {
    const state = getStateById(stateId);
    if (!state) return [];
    return [
      {
        value: state.id,
        label: getPpmStateDisplayName(state, currentLocale) ?? state.name,
        query: state.name,
        icon: (
          <StateGroupIcon stateGroup={state.group} color={state.color} className="size-3.5" percentage={state.order} />
        ),
        isCurrent: commonStateId === state.id,
      },
    ];
  });

  const memberLists = projectIds.map((projectId) => getProjectMemberIds(projectId, false));
  const memberIds = intersectPpmMemberIds(memberLists);
  const commonAssignee = getCommonAssignee(selectedIssues);
  const assigneeOptions: TPpmBulkPickerOption[] | undefined = memberIds
    ? [
        {
          value: PPM_BULK_NONE,
          label: ppmT("bulk.assignee_none"),
          icon: <UserCirclePropertyIcon className="size-3.5 text-tertiary" />,
          isCurrent: commonAssignee === PPM_BULK_NONE,
        },
        ...memberIds.flatMap((userId) => {
          const user = getUserDetails(userId);
          if (!user) return [];
          return [
            {
              value: userId,
              label: user.display_name,
              query: `${user.first_name ?? ""} ${user.last_name ?? ""}`,
              icon: (
                <Avatar
                  name={user.display_name}
                  src={getFileURL(user.avatar_url ?? "")}
                  size="sm"
                  showTooltip={false}
                />
              ),
              isCurrent: commonAssignee === userId,
            },
          ];
        }),
      ]
    : undefined;

  const commonCycleId = commonValue(selectedIssues.map((issue) => issue.cycleId));
  const cycles = singleProjectId ? getProjectCycleDetails(singleProjectId) : null;
  const sprintOptions: TPpmBulkPickerOption[] | undefined = cycles
    ? [
        {
          value: PPM_BULK_NONE,
          label: ppmT("bulk.sprint_none"),
          icon: <CycleIcon className="size-3.5 text-tertiary" />,
          isCurrent: commonCycleId === null,
        },
        ...getPpmBulkSprintOptions(cycles, new Date()).map((option) => ({
          value: option.id,
          label: option.name,
          meta: ppmT(SPRINT_PHASE_KEYS[option.phase]),
          icon: <CycleGroupIcon cycleGroup={option.phase} className="size-3.5" />,
          isCurrent: commonCycleId === option.id,
        })),
      ]
    : undefined;

  // Варианты загружаются при открытии меню, как у выпадающих списков свойств задачи.
  const loadStates = () => {
    if (workspaceSlug && singleProjectId && !stateIds) void fetchProjectStates(workspaceSlug, singleProjectId);
  };
  const loadMembers = () => {
    if (!workspaceSlug) return;
    projectIds.forEach((projectId, index) => {
      if (!memberLists[index]) void fetchProjectMembers(workspaceSlug, projectId);
    });
  };
  const loadCycles = () => {
    if (workspaceSlug && singleProjectId && !cycles) void fetchAllCycles(workspaceSlug, singleProjectId);
  };

  // ---------------- действия: что делать по нажатию — bulk-flow.ts ----------------
  const flowIO: TPpmBulkFlowIO = {
    translate: ppmT,
    locale: currentLocale,
    notify: (toast) => setToast({ type: TOAST_TYPES[toast.type], title: toast.title, message: toast.message }),
    deselect: (issueIds) => {
      const entities = issueIds
        .map((issueId) => getEntityDetailsFromEntityID(issueId))
        .filter((entity): entity is TEntityDetails => !!entity);
      if (entities.length > 0) bulkUpdateSelectedEntityDetails(entities, "remove");
    },
    reselect: (entities) => {
      const entitiesToAdd = getPpmEntitiesToAdd(entities, getIsEntitySelected);
      if (entitiesToAdd.length > 0) bulkUpdateSelectedEntityDetails(entitiesToAdd, "add");
    },
  };

  const updateIO: TPpmBulkUpdateIO = {
    ...flowIO,
    updateIssue: (projectId, issueId, data) => store.updateIssue(workspaceSlug, projectId, issueId, data),
    addIssuesToCycle: (projectId, cycleId, issueIds) =>
      store.addIssueToCycle(workspaceSlug, projectId, cycleId, issueIds, false),
    removeIssueFromCycle: (projectId, issueId) => store.removeCycleFromIssue(workspaceSlug, projectId, issueId),
    // Счётчики открытого спринта — одним запросом после переноса; сбой не делает перенос неудачным.
    refreshCycleStats: (projectId) =>
      void Promise.resolve(store.fetchParentStats?.(workspaceSlug, projectId)).catch(() => undefined),
  };
  const runUpdate = (command: TPpmBulkUpdateCommand) => {
    if (!workspaceSlug) return;
    void runPpmBulkUpdateFlow(selectedIssues, selection, command, updateIO);
  };
  const handleState = (stateId: string) => runUpdate({ kind: "state", stateId });
  const handleAssignee = (value: string) =>
    runUpdate({ kind: "assignee", memberId: value === PPM_BULK_NONE ? null : value });
  const handleSprint = (value: string) => runUpdate({ kind: "cycle", cycleId: value === PPM_BULK_NONE ? null : value });

  const deleteIO: TPpmBulkDeleteIO = {
    ...flowIO,
    rights,
    getParentId,
    confirm,
    // То же действие, что у обычного диалога удаления.
    removeIssue: (projectId, issueId) => removeIssue(projectId, issueId),
    // Подзадачи, которые сервер удалил вместе с родителем, — строки убираем сами (их удаление не отправлялось).
    removeFromList: (issueIds) => issueIds.forEach((issueId) => store.removeIssueFromList(issueId)),
  };
  const handleDelete = () => {
    // Без пространства в адресе действие обычного удаления молча ничего не делает — не выдаём это за «удалено».
    if (!workspaceSlug) return;
    void runPpmBulkDeleteFlow(selectedIssues, deleteIO, selection);
  };

  const pickerTexts = {
    searchPlaceholder: ppmT("bulk.search"),
    noMatchesText: ppmT("bulk.no_matches"),
    loadingText: ppmT("bulk.loading"),
    emptyText: ppmT("bulk.no_options"),
  };
  const assigneeHint =
    projectIds.length > 1
      ? `${ppmT("bulk.assignee_replace_hint")}. ${ppmT("bulk.assignee_common_hint")}`
      : ppmT("bulk.assignee_replace_hint");

  return (
    <>
      <PpmBulkActionBarView
        className={className}
        regionLabel={ppmT("bulk.region_label")}
        countLabel={formatPpmBulkCount(ppmT, "bulk.selected", selectedIssues.length, currentLocale)}
        busy={isBusy}
        busyLabel={ppmT("bulk.busy")}
        isDesignV2={isDesignV2}
        pickers={
          <>
            <PpmBulkPicker
              id="ppm-bulk-status"
              label={ppmT("bulk.status")}
              hint={hintOf(availability.statusHintKey)}
              busy={isBusy}
              options={statusOptions}
              onOpen={loadStates}
              onSelect={handleState}
              {...pickerTexts}
            />
            <PpmBulkPicker
              id="ppm-bulk-assignee"
              label={ppmT("bulk.assignee")}
              hint={hintOf(availability.assigneeHintKey)}
              busy={isBusy}
              options={assigneeOptions}
              onOpen={loadMembers}
              onSelect={handleAssignee}
              menuHint={assigneeHint}
              {...pickerTexts}
            />
            <PpmBulkPicker
              id="ppm-bulk-sprint"
              label={ppmT("bulk.sprint")}
              hint={hintOf(availability.sprintHintKey)}
              busy={isBusy}
              options={sprintOptions}
              onOpen={loadCycles}
              onSelect={handleSprint}
              {...pickerTexts}
            />
          </>
        }
        deleteLabel={ppmT("bulk.delete")}
        deleteHint={hintOf(availability.deleteHintKey)}
        deleteNote={
          availability.deletableCount > 0 && availability.deletableCount < availability.total
            ? formatPpmTemplate(ppmT("bulk.delete_partial_note"), {
                allowed: availability.deletableCount,
                total: availability.total,
              })
            : null
        }
        onDelete={handleDelete}
        clearLabel={ppmT("bulk.clear")}
        onClear={clearSelection}
      />
      {confirmDialog}
    </>
  );
});
