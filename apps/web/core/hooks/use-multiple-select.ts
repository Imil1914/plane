/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
// hooks
import { useMultipleSelectStore } from "@/hooks/store/use-multiple-select-store";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
//
import {
  getPpmEntitiesToAdd,
  getPpmMissingSelection,
  getPpmNeighbourEntities,
  getPpmShiftRange,
  isPpmSelectionKeyTargetIgnored,
} from "./use-multiple-select-helpers";
import type { TPpmIsEntityHidden } from "./use-multiple-select-helpers";
import useReloadConfirmations from "./use-reload-confirmation";

export type TEntityDetails = {
  entityID: string;
  groupID: string;
};

type Props = {
  containerRef: React.MutableRefObject<HTMLElement | null>;
  disabled: boolean;
  entities: Record<string, string[]>; // { groupID: entityIds[] }
  /** PPM (линия B): строка скрыта (её группа свёрнута) — Shift-диапазон и стрелки её пропускают. */
  isEntityHidden?: TPpmIsEntityHidden;
};

export type TSelectionSnapshot = {
  isSelectionActive: boolean;
  selectedEntityIds: string[];
};

export type TSelectionHelper = {
  handleClearSelection: () => void;
  handleEntityClick: (event: React.MouseEvent, entityID: string, groupId: string) => void;
  getIsEntitySelected: (entityID: string) => boolean;
  getIsEntityActive: (entityID: string) => boolean;
  handleGroupClick: (groupID: string) => void;
  isGroupSelected: (groupID: string) => "empty" | "partial" | "complete";
  isSelectionDisabled: boolean;
  /** Выделена хотя бы одна задача: флажки строк видны без наведения (линия B). */
  isSelectionActive: boolean;
};

export const useMultipleSelect = (props: Props) => {
  const { containerRef, disabled, entities, isEntityHidden } = props;
  // Последняя функция «строка скрыта» без переподписки слушателей клавиш на каждый рендер списка.
  const isEntityHiddenRef = useRef(isEntityHidden);
  isEntityHiddenRef.current = isEntityHidden;
  const isHidden = useCallback((entity: TEntityDetails) => !!isEntityHiddenRef.current?.(entity), []);
  // router
  // const router = useAppRouter();
  // store hooks
  const multipleSelectStore = useMultipleSelectStore();
  const {
    isSelectionActive,
    selectedEntityIds,
    updateSelectedEntityDetails,
    bulkUpdateSelectedEntityDetails,
    getActiveEntityDetails,
    updateActiveEntityDetails,
    updatePreviousActiveEntity,
    updateNextActiveEntity,
    getLastSelectedEntityDetails,
    updateLastSelectedEntityDetails,
    clearSelection,
    getIsEntitySelected,
    getIsEntityActive,
    getEntityDetailsFromEntityID,
  } = multipleSelectStore;
  const ppmT = usePpmTranslation();

  useReloadConfirmations(selectedEntityIds && selectedEntityIds.length > 0, ppmT("bulk.leave_confirm"), true, () => {
    clearSelection();
  });

  const groups = useMemo(() => Object.keys(entities), [entities]);

  const entitiesList: TEntityDetails[] = useMemo(
    () =>
      groups
        ?.map((groupID) =>
          entities?.[groupID]?.map((entityID) => ({
            entityID,
            groupID,
          }))
        )
        .flat(1),
    [entities, groups]
  );

  // PPM (линия B): соседи — по паре «задача + группа» (одна задача бывает в нескольких группах) и мимо свёрнутых групп.
  const getPreviousAndNextEntities = useCallback(
    (entityDetails: TEntityDetails) => getPpmNeighbourEntities(entitiesList, entityDetails, isHidden),
    [entitiesList, isHidden]
  );

  const handleActiveEntityChange = useCallback(
    (entityDetails: TEntityDetails | null, shouldScroll: boolean = true) => {
      if (disabled) return;

      if (!entityDetails) {
        updateActiveEntityDetails(null);
        updatePreviousActiveEntity(null);
        updateNextActiveEntity(null);
        return;
      }

      updateActiveEntityDetails(entityDetails);

      // scroll to get the active element in view
      const activeElement = document.querySelector(
        `[data-entity-id="${entityDetails.entityID}"][data-entity-group-id="${entityDetails.groupID}"]`
      );
      if (activeElement && containerRef.current && shouldScroll) {
        const SCROLL_OFFSET = 200;
        const containerRect = containerRef.current.getBoundingClientRect();
        const elementRect = activeElement.getBoundingClientRect();

        const isInView =
          elementRect.top >= containerRect.top + SCROLL_OFFSET &&
          elementRect.bottom <= containerRect.bottom - SCROLL_OFFSET;

        if (!isInView) {
          containerRef.current.scrollBy({
            top: elementRect.top < containerRect.top + SCROLL_OFFSET ? -50 : 50,
          });
        }
      }

      const { previousEntity: previousActiveEntity, nextEntity: nextActiveEntity } =
        getPreviousAndNextEntities(entityDetails);
      updatePreviousActiveEntity(previousActiveEntity);
      updateNextActiveEntity(nextActiveEntity);
    },
    [
      containerRef,
      disabled,
      getPreviousAndNextEntities,
      updateActiveEntityDetails,
      updateNextActiveEntity,
      updatePreviousActiveEntity,
    ]
  );

  const handleEntitySelection = useCallback(
    (
      entityDetails: TEntityDetails | TEntityDetails[],
      shouldScroll: boolean = true,
      forceAction: "force-add" | "force-remove" | null = null
    ) => {
      if (disabled) return;

      if (Array.isArray(entityDetails)) {
        if (forceAction !== "force-add") {
          bulkUpdateSelectedEntityDetails(entityDetails, "remove");
          return;
        }
        // PPM (линия B): каждая задача один раз (она бывает в нескольких группах) и без уже выделенных — иначе
        // «Выбрано: N» и удаление считали бы одну задачу дважды.
        const entitiesToAdd = getPpmEntitiesToAdd(entityDetails, getIsEntitySelected);
        if (entitiesToAdd.length > 0) {
          bulkUpdateSelectedEntityDetails(entitiesToAdd, "add");
          handleActiveEntityChange(entitiesToAdd[entitiesToAdd.length - 1], shouldScroll);
        }
        return;
      }

      if (forceAction) {
        if (forceAction === "force-add") {
          updateSelectedEntityDetails(entityDetails, "add");
          handleActiveEntityChange(entityDetails, shouldScroll);
        }
        if (forceAction === "force-remove") {
          updateSelectedEntityDetails(entityDetails, "remove");
        }
        return;
      }

      const isSelected = getIsEntitySelected(entityDetails.entityID);
      if (isSelected) {
        updateSelectedEntityDetails(entityDetails, "remove");
        handleActiveEntityChange(entityDetails, shouldScroll);
      } else {
        updateSelectedEntityDetails(entityDetails, "add");
        handleActiveEntityChange(entityDetails, shouldScroll);
      }
    },
    [
      bulkUpdateSelectedEntityDetails,
      disabled,
      getIsEntitySelected,
      handleActiveEntityChange,
      updateSelectedEntityDetails,
    ]
  );

  /**
   * @description toggle entity selection
   * @param {React.MouseEvent} event
   * @param {string} entityID
   * @param {string} groupID
   */
  const handleEntityClick = useCallback(
    (e: React.MouseEvent, entityID: string, groupID: string) => {
      if (disabled) return;
      const lastSelectedEntityDetails = getLastSelectedEntityDetails();
      if (e.shiftKey && lastSelectedEntityDetails) {
        // PPM (линия B): весь диапазон получает состояние нажатой задачи — выделяется целиком или целиком снимается
        // (раньше каждая задача диапазона переключалась и уже выделенные внутри него снимались). Опорная и нажатая
        // строки — по паре «задача + группа», строки свёрнутых групп не входят, повторы и уже выделенные не добавляются.
        const target = { entityID, groupID };
        const range = getPpmShiftRange(entitiesList, lastSelectedEntityDetails, target, isHidden);
        if (range.length > 0) {
          if (getIsEntitySelected(entityID)) handleEntitySelection(range, false, "force-remove");
          else {
            handleEntitySelection(range, false, "force-add");
            // Следующий Shift-клик и стрелки — от нажатой строки, а не от последней добавленной.
            updateLastSelectedEntityDetails(target);
            handleActiveEntityChange(target, false);
          }
          return;
        }
      }

      handleEntitySelection({ entityID, groupID }, false);
    },
    [
      disabled,
      entitiesList,
      handleActiveEntityChange,
      handleEntitySelection,
      getIsEntitySelected,
      getLastSelectedEntityDetails,
      isHidden,
      updateLastSelectedEntityDetails,
    ]
  );

  /**
   * @description check if any entity of the group is selected
   * @param {string} groupID
   * @returns {boolean}
   */
  const isGroupSelected = useCallback(
    (groupID: string) => {
      const groupEntities = entitiesList.filter((entity) => entity.groupID === groupID);
      const totalSelected = groupEntities.filter((entity) => getIsEntitySelected(entity?.entityID ?? "")).length;
      if (totalSelected === 0) return "empty";
      if (totalSelected === groupEntities.length) return "complete";
      return "partial";
    },
    [entitiesList, getIsEntitySelected]
  );

  /**
   * @description toggle group selection
   * @param {string} groupID
   */
  const handleGroupClick = useCallback(
    (groupID: string) => {
      if (disabled) return;

      const groupEntities = entitiesList.filter((entity) => entity.groupID === groupID);
      const groupSelectionStatus = isGroupSelected(groupID);
      handleEntitySelection(groupEntities, false, groupSelectionStatus === "empty" ? "force-add" : "force-remove");
    },
    [disabled, entitiesList, handleEntitySelection, isGroupSelected]
  );

  // select entities on shift + arrow up/down key press
  useEffect(() => {
    if (disabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.shiftKey) return;
      // PPM (линия B): только пока идёт выделение и не из полей, редакторов, диалогов и меню — Shift+↓ при выделении
      // текста в карточке задачи не должен выделять задачи в списке за ней.
      if (!multipleSelectStore.isSelectionActive || isPpmSelectionKeyTargetIgnored(e.target)) return;

      const activeEntityDetails = getActiveEntityDetails();
      // Соседи — на момент нажатия: группа могла свернуться после того, как строка стала активной.
      const { nextEntity: nextActiveEntity, previousEntity: previousActiveEntity } = activeEntityDetails
        ? getPreviousAndNextEntities(activeEntityDetails)
        : { nextEntity: null, previousEntity: null };

      if (e.key === "ArrowDown" && activeEntityDetails) {
        if (!nextActiveEntity) return;
        handleEntitySelection(nextActiveEntity);
      }
      if (e.key === "ArrowUp" && activeEntityDetails) {
        if (!previousActiveEntity) return;
        handleEntitySelection(previousActiveEntity);
      }
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [disabled, getActiveEntityDetails, getPreviousAndNextEntities, handleEntitySelection, multipleSelectStore]);

  useEffect(() => {
    if (disabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.shiftKey) return;
      // PPM (линия B): стрелки двигают активную строку только во время выделения и не из полей, диалогов и меню.
      if (!multipleSelectStore.isSelectionActive || isPpmSelectionKeyTargetIgnored(e.target)) return;
      const activeEntityDetails = getActiveEntityDetails();
      // set active entity id to the first entity
      if (["ArrowUp", "ArrowDown"].includes(e.key) && !activeEntityDetails) {
        const firstElementDetails = entitiesList.find((entity) => !isHidden(entity));
        if (!firstElementDetails) return;
        handleActiveEntityChange(firstElementDetails);
      }

      if (e.key === "ArrowDown" && activeEntityDetails) {
        if (!activeEntityDetails) return;
        const { nextEntity: nextActiveEntity } = getPreviousAndNextEntities(activeEntityDetails);
        if (nextActiveEntity) {
          handleActiveEntityChange(nextActiveEntity);
        }
      }

      if (e.key === "ArrowUp" && activeEntityDetails) {
        if (!activeEntityDetails) return;
        const { previousEntity: previousActiveEntity } = getPreviousAndNextEntities(activeEntityDetails);
        if (previousActiveEntity) {
          handleActiveEntityChange(previousActiveEntity);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    disabled,
    getActiveEntityDetails,
    entitiesList,
    groups,
    getPreviousAndNextEntities,
    handleActiveEntityChange,
    isHidden,
    multipleSelectStore,
  ]);

  // PPM (линия B): список закрылся (другая страница, другой вид) — выделение не переезжает на следующий экран.
  useEffect(() => {
    if (disabled) return;
    return () => clearSelection();
  }, [clearSelection, disabled]);

  // clear selection on route change
  // useEffect(() => {
  //   const handleRouteChange = () => clearSelection();

  //   router.events.on("routeChangeComplete", handleRouteChange);

  //   return () => {
  //     router.events.off("routeChangeComplete", handleRouteChange);
  //   };
  // }, [clearSelection, router.events]);

  // when entities list change, remove entityIds from the selected entities array, which are not present in the new list
  // PPM (линия B): одним снятием и без «призрачной» активной строки — удалённые, отфильтрованные и ушедшие при
  // перезагрузке списка задачи не остаются ни в выделении, ни курсором клавиатуры.
  useEffect(() => {
    if (disabled) return;
    const missing = getPpmMissingSelection(selectedEntityIds, entitiesList)
      .map((entityID) => getEntityDetailsFromEntityID(entityID))
      .filter((entityDetails): entityDetails is TEntityDetails => !!entityDetails);
    if (missing.length > 0) handleEntitySelection(missing, false, "force-remove");
    const activeEntityDetails = getActiveEntityDetails();
    if (activeEntityDetails && !entitiesList.some((entity) => entity.entityID === activeEntityDetails.entityID))
      handleActiveEntityChange(null, false);
  }, [
    disabled,
    entitiesList,
    getActiveEntityDetails,
    getEntityDetailsFromEntityID,
    handleActiveEntityChange,
    handleEntitySelection,
    selectedEntityIds,
  ]);

  /**
   * @description helper functions for selection
   */
  const helpers: TSelectionHelper = useMemo(
    () => ({
      handleClearSelection: clearSelection,
      handleEntityClick,
      getIsEntitySelected,
      getIsEntityActive,
      handleGroupClick,
      isGroupSelected,
      isSelectionDisabled: disabled,
      isSelectionActive,
    }),
    [
      clearSelection,
      disabled,
      getIsEntityActive,
      getIsEntitySelected,
      handleEntityClick,
      handleGroupClick,
      isGroupSelected,
      isSelectionActive,
    ]
  );

  return helpers;
};
