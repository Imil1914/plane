/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createShapeId, useValue, type TLShapeId } from "tldraw";
import type { TPpmWorkItemEditOptions } from "@ppm/canvas";
import { createLivingMapLoaders, PpmCanvasMapService } from "@/services/ppm-canvas-map.service";
import { PpmCanvasService } from "@/services/ppm-canvas.service";
import { EMPTY_LIVING_MAP_FACTS, type TLivingMapArgs, type TLivingMapFacts } from "./living-map-types";
import {
  boardWorkItemIds,
  cacheProjectIssues,
  computeLivingMapView,
  EMPTY_LIVING_MAP_DATA,
  liveCardsFromSignature,
  liveCardsSignature,
  livingMapLoadKey,
  loadLivingMapData,
  type TLivingMapData,
} from "./map-data";
import {
  decodeMapGroups,
  encodeMapGroups,
  mapGroupsOf,
  shapeNodeJson,
  sprintFrameOf,
  type TPlaceOnMapResult,
} from "./map-model";
import { applyMapChange, mapStateFromRecords, readMapRecords, revealMapCards } from "./map-shapes";
import { placeOnMap, selectTrayRequests } from "./not-on-map";

// AF2.2 M: факты «Живой карты» для провайдера F. Данные Plane (спринт рамки, направления, задачи со связями, PR) читает
// лишь активная вкладка v2 (AF2.1 R19): при открытии, при смене карточек или их версий и раз в 60 с — только чтение.
// В доску пишет лишь placeFromTray — по нажатию «+ Добавить» / «Разложить всё» в лотке (M4). args.enabled === false
// (v1, минимальный режим) — пусто и без запросов.
// Не импортировать living-map-context.ts (его импортирует провайдер — был бы цикл).

const NO_WORK_ITEM_OPTIONS: TPpmWorkItemEditOptions = { assignees: [], priorities: [], states: [] };
const LIVING_MAP_DEBOUNCE_MS = 400;
const LIVING_MAP_STALE_MS = 60_000;

export function useLivingMapFacts(args: TLivingMapArgs): TLivingMapFacts {
  const { bindingsByShapeId, editor, enabled, isActive, projectId, workspaceId, workspaceSlug } = args;
  const projectIdentifier = args.projectIdentifier ?? null;
  const workItemOptions = args.workItemOptions ?? NO_WORK_ITEM_OPTIONS;
  // Группы карты и живые карточки — строками-подписями: пересчёт на каждое изменение фигур дешёвый, а перерисовка —
  // только при смене состава (роли групп, их дети, карточки, версии источников), не на кадрах перетаскивания и камеры.
  const groupsKey = useValue(
    "ppm living map groups",
    () =>
      editor && enabled
        ? encodeMapGroups(
            mapGroupsOf(
              editor
                .getCurrentPageShapesSorted()
                .map((shape) => ({ id: shape.id, node: shapeNodeJson(shape), parentId: shape.parentId }))
            )
          )
        : "",
    [editor, enabled]
  );
  const cardsKey = useValue(
    "ppm living map cards",
    () =>
      editor && enabled
        ? liveCardsSignature(bindingsByShapeId, (shapeId) => Boolean(editor.getShape(shapeId as TLShapeId)))
        : "",
    [bindingsByShapeId, editor, enabled]
  );
  const groups = useMemo(() => decodeMapGroups(groupsKey), [groupsKey]);
  const cards = useMemo(() => liveCardsFromSignature(cardsKey, bindingsByShapeId), [bindingsByShapeId, cardsKey]);
  const cycleId = sprintFrameOf(groups)?.map.cycle_id ?? null;
  const loadKey = enabled ? livingMapLoadKey(cycleId, cards) : "";
  // M-3: проектный список задач загрузчики помнят 5 минут (задачи спринта — каждые 60 с). Память — на доску и проект:
  // хук живёт в редакторе одной доски (workspace.tsx монтирует редактор на открытую доску, key={boardId}).
  const loaders = useMemo(() => {
    const plain = createLivingMapLoaders(new PpmCanvasMapService(), { projectId, workspaceId, workspaceSlug });
    return { ...plain, projectIssues: cacheProjectIssues(plain.projectIssues) };
  }, [projectId, workspaceId, workspaceSlug]);
  const [data, setData] = useState<TLivingMapData>(EMPTY_LIVING_MAP_DATA);
  const [tick, setTick] = useState(0);
  const requestRef = useRef(0);
  const loadedRef = useRef({ at: 0, key: "" });
  const inputsRef = useRef({ cycleId, workItemIds: boardWorkItemIds(cards) });
  inputsRef.current = { cycleId, workItemIds: boardWorkItemIds(cards) };

  useEffect(() => {
    if (!loadKey || !isActive) return;
    const interval = window.setInterval(() => setTick((value) => value + 1), LIVING_MAP_STALE_MS);
    return () => window.clearInterval(interval);
  }, [isActive, loadKey]);

  useEffect(() => {
    if (!loadKey || !isActive) return;
    if (loadedRef.current.key === loadKey && Date.now() - loadedRef.current.at < LIVING_MAP_STALE_MS) return;
    const timer = window.setTimeout(() => {
      const request = ++requestRef.current;
      const inputs = inputsRef.current;
      void loadLivingMapData(loaders, {
        boardWorkItemIds: inputs.workItemIds,
        cycleId: inputs.cycleId,
        now: Date.now(),
      })
        .then((loaded) => {
          if (request !== requestRef.current) return undefined;
          loadedRef.current = { at: loaded.loadedAt, key: loadKey };
          setData(loaded);
          return undefined;
        })
        // Сбой чтения не стирает последние известные данные: карта остаётся как была.
        .catch(() => undefined);
    }, LIVING_MAP_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [isActive, loadKey, loaders, tick]);

  const view = useMemo(
    () =>
      computeLivingMapView({
        cards,
        data,
        groups,
        options: workItemOptions,
        projectId,
        projectIdentifier,
        today: new Date(),
      }),
    [cards, data, groups, projectId, projectIdentifier, workItemOptions]
  );

  const [placing, setPlacing] = useState(false);
  const placingRef = useRef(false);
  const argsRef = useRef(args);
  argsRef.current = args;
  const trayItemsRef = useRef(view.tray.items);
  trayItemsRef.current = view.tray.items;
  const frameId = sprintFrameOf(groups)?.id ?? null;
  const placeFromTray = useCallback(
    async (keys: readonly string[], noDirectionTitle: string): Promise<TPlaceOnMapResult | null> => {
      const current = argsRef.current;
      const activeEditor = current.editor;
      // Только по нажатию редактора в активной вкладке своей карты (AF2.1 R19); сам лоток ничего не добавляет.
      if (!current.enabled || !current.canEdit || !current.isActive || !activeEditor || !frameId || placingRef.current)
        return null;
      // RM-c и RM-d: что кладёт это нажатие — только задачи и PR с объектом Git, не больше 200 и не больше места в
      // ближайшем сохранении доски (selectTrayRequests); остальное — следующим нажатием («нажмите ещё раз»).
      const selection = selectTrayRequests({
        bindings: current.bindingsByShapeId,
        items: trayItemsRef.current,
        keys,
        noDirectionTitle,
      });
      if (!selection) return null;
      const { remaining, requests } = selection;
      if (requests.length === 0) return { cardIds: [], failed: 0, placed: 0, remaining };
      placingRef.current = true;
      setPlacing(true);
      const canvas = new PpmCanvasService();
      const mapService = new PpmCanvasMapService();
      const { boardId, projectId: project, workspaceId: workspace } = current;
      try {
        const result = await placeOnMap(
          {
            applyChange: (change) => applyMapChange(activeEditor, change),
            authorId: current.authorId,
            bindBatch: (items) => mapService.bindBatch(workspace, project, boardId, items),
            cancelBinding: (bindingId) => canvas.cancelPendingBinding(workspace, project, boardId, bindingId),
            newShapeId: () => createShapeId(),
            now: () => new Date().toISOString(),
            readState: () => mapStateFromRecords(readMapRecords(activeEditor), frameId),
            registerBindings: current.registerBindings,
          },
          requests
        );
        revealMapCards(activeEditor, result.cardIds);
        return { ...result, remaining };
      } finally {
        placingRef.current = false;
        setPlacing(false);
      }
    },
    [frameId]
  );

  return useMemo<TLivingMapFacts>(
    () =>
      enabled
        ? {
            facts: view.facts,
            mapSections: view.mapSections,
            modules: view.modules,
            placeFromTray,
            placing,
            relationEdges: view.relationEdges,
            sprint: view.sprint,
            tray: view.tray,
          }
        : EMPTY_LIVING_MAP_FACTS,
    [enabled, placeFromTray, placing, view]
  );
}
