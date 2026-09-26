/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { ArrowRightToLine, ArrowUpRight, Clock, Flag, Timer } from "lucide-react";
import { stopEventPropagation } from "tldraw";
import type { TPpmCanvasGroupNode } from "@ppm/canvas";
import { useTranslation } from "@plane/i18n";
import { computePpmSprintScale, formatPpmSprintRange, type TPpmSprintScale } from "@/components/ppm-tasks/sprint";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { fillCanvasTemplate } from "../canvas-grammar";
import { LiveGlyph } from "../live-card";
import type { TPpmCanvasShape } from "../shape";
import { usePpmLivingMap } from "./living-map-context";
import { pluralKey } from "./map-model";

// AF2.2 M1: узел group с полем map (K5). Рамка спринта — «Спринт · даты», живая шкала «День N из M · K из T задач
// готово», «Открыть в Спринтах ↗»; секция направления — «Название · N задач», бейджи «Светофора», «↗». Данные —
// usePpmLivingMap() (факты M и окружение F); заголовок узла — запас, пока Plane не прочитан.
const SCALE_WIDTH = 200;
const DONE_KEYS = {
  few: "canvas.map.sprint_done_few",
  many: "canvas.map.sprint_done_many",
  one: "canvas.map.sprint_done_one",
} as const;
const TASK_KEYS = {
  few: "canvas.map.section_tasks_few",
  many: "canvas.map.section_tasks_many",
  one: "canvas.map.section_tasks_one",
} as const;
const OVERDUE_KEYS = {
  few: "canvas.map.section_overdue_few",
  many: "canvas.map.section_overdue_many",
  one: "canvas.map.section_overdue_one",
} as const;
const BLOCKED_KEYS = {
  few: "canvas.map.section_blocked_few",
  many: "canvas.map.section_blocked_many",
  one: "canvas.map.section_blocked_one",
} as const;

export function LivingMapGroupCard({ node, shape }: { node: TPpmCanvasGroupNode; shape: TPpmCanvasShape }) {
  if (!node.map) return null;
  return node.map.role === "sprint" ? (
    <SprintFrameHeader cycleId={node.map.cycle_id} shapeId={shape.id} title={node.title} />
  ) : (
    <MapSectionHeader moduleId={node.map.module_id} shapeId={shape.id} title={node.title} />
  );
}

function SprintFrameHeader({ cycleId, shapeId, title }: { cycleId: string; shapeId: string; title: string }) {
  const ppmT = usePpmTranslation();
  const { currentLocale } = useTranslation();
  const { args, mapSections, sprint } = usePpmLivingMap();
  const known = sprint?.cycleId === cycleId ? sprint : null;
  const info = known && !known.missing ? known : null;
  const summary = mapSections.get(shapeId);
  const range = info ? formatPpmSprintRange(info.startDate, info.endDate, currentLocale) : null;
  const heading =
    info && range ? fillCanvasTemplate(ppmT("canvas.map.sprint_title"), { name: info.name, range }) : title;
  const scale = info ? computePpmSprintScale(info.startDate, info.endDate, new Date()) : null;
  // «K из T задач готово» — по спринту Plane (как «Спринты»); пока он не прочитан — по карточкам этой рамки.
  const done = info ? info.done : (summary?.done ?? 0);
  const total = info ? info.total : (summary?.total ?? 0);
  const openLabel = fillCanvasTemplate(ppmT("canvas.map.sprint_open_label"), { name: info?.name || title });
  return (
    <div className="ppm-map-group" data-ppm-map-role="sprint">
      <header className="ppm-map-sprint__header">
        <Timer aria-hidden="true" className="ppm-map-group__icon" />
        <h2 className="ppm-map-sprint__title" title={ppmT("canvas.map.sprint_live_hint")}>
          {heading}
        </h2>
        <LiveGlyph />
        {known?.missing && <span className="ppm-map-sprint__meta">{ppmT("canvas.map.sprint_missing")}</span>}
        {scale && <SprintScale done={done} scale={scale} total={total} />}
        {args.workspaceSlug && (
          <a
            className="ppm-map-sprint__open"
            aria-label={openLabel}
            href={`/${args.workspaceSlug}/projects/${args.projectId}/cycles/${cycleId}`}
            title={openLabel}
            onClick={stopEventPropagation}
            onKeyDown={stopEventPropagation}
            onPointerDown={stopEventPropagation}
          >
            {ppmT("canvas.map.sprint_open")}
            <ArrowUpRight aria-hidden="true" />
          </a>
        )}
      </header>
    </div>
  );
}

function SprintScale({ done, scale, total }: { done: number; scale: TPpmSprintScale; total: number }) {
  const ppmT = usePpmTranslation();
  const { currentLocale } = useTranslation();
  const share = total > 0 ? Math.min(1, done / total) : 0;
  const todayX = 1 + Math.round(scale.todayPosition * (SCALE_WIDTH - 2));
  const dayLabel = fillCanvasTemplate(ppmT("tasks.sprint.day_of"), { day: scale.dayIndex, total: scale.totalDays });
  const doneLabel = fillCanvasTemplate(ppmT(pluralKey(total, currentLocale, DONE_KEYS)), { done, total });
  return (
    <span className="ppm-map-sprint__scale">
      <svg
        aria-label={fillCanvasTemplate(ppmT("canvas.map.sprint_progress"), {
          day: scale.dayIndex,
          days: scale.totalDays,
          done,
          total,
        })}
        className="ppm-map-sprint__bar"
        height="12"
        role="img"
        viewBox={`0 0 ${SCALE_WIDTH} 12`}
        width={SCALE_WIDTH}
      >
        <rect className="ppm-map-sprint__track" height="6" rx="3" width={SCALE_WIDTH} x="0" y="3" />
        <rect className="ppm-map-sprint__done" height="6" rx="3" width={Math.round(SCALE_WIDTH * share)} x="0" y="3" />
        <path className="ppm-map-sprint__today" d={`M${todayX} 0.75V11.25`} />
      </svg>
      <span className="ppm-map-sprint__meta">{`${dayLabel} · ${doneLabel}`}</span>
    </span>
  );
}

function MapSectionHeader({ moduleId, shapeId, title }: { moduleId: string | null; shapeId: string; title: string }) {
  const ppmT = usePpmTranslation();
  const { currentLocale } = useTranslation();
  const { args, mapSections, modules, trafficLight } = usePpmLivingMap();
  const summary = mapSections.get(shapeId);
  const tasks = summary?.total ?? 0;
  const name = moduleId ? (modules?.get(moduleId)?.name ?? title) : ppmT("canvas.map.section_no_direction");
  const href =
    moduleId && args.workspaceSlug ? `/${args.workspaceSlug}/projects/${args.projectId}/modules/${moduleId}` : null;
  const openLabel = fillCanvasTemplate(ppmT("canvas.map.section_open"), { name });
  return (
    <div className="ppm-map-group" data-ppm-map-role="section">
      <header className="ppm-map-section__header">
        <Flag aria-hidden="true" className="ppm-map-group__icon" />
        <h3 className="ppm-map-section__title">{name}</h3>
        <span className="ppm-map-section__count">
          {`· ${fillCanvasTemplate(ppmT(pluralKey(tasks, currentLocale, TASK_KEYS)), { count: tasks })}`}
        </span>
        {trafficLight && summary && summary.overdue > 0 && (
          <span className="ppm-map-badge" data-tone="overdue">
            <Clock aria-hidden="true" />
            {fillCanvasTemplate(ppmT(pluralKey(summary.overdue, currentLocale, OVERDUE_KEYS)), {
              count: summary.overdue,
            })}
          </span>
        )}
        {trafficLight && summary && summary.blocked > 0 && (
          <span className="ppm-map-badge" data-tone="blocked">
            <ArrowRightToLine aria-hidden="true" />
            {fillCanvasTemplate(ppmT(pluralKey(summary.blocked, currentLocale, BLOCKED_KEYS)), {
              count: summary.blocked,
            })}
          </span>
        )}
        {href && (
          <a
            className="ppm-map-section__open"
            aria-label={openLabel}
            href={href}
            title={openLabel}
            onClick={stopEventPropagation}
            onKeyDown={stopEventPropagation}
            onPointerDown={stopEventPropagation}
          >
            <ArrowUpRight aria-hidden="true" />
          </a>
        )}
      </header>
    </div>
  );
}
