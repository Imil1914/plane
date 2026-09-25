/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useParams } from "next/navigation";
import { useTranslation } from "@plane/i18n";
import { useCycle } from "@/hooks/store/use-cycle";
import { useProject } from "@/hooks/store/use-project";
import { useAppRouter } from "@/hooks/use-app-router";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { formatPpmTemplate } from "./format";
import { computePpmSprintScale, formatPpmSprintRange, PPM_DAYS_LEFT_KEYS, selectPpmPluralKey } from "./sprint";
import { PpmSprintScaleView } from "./sprint-scale-view";

/** Только при включённых спринтах и текущем спринте; данные уже в cycle.store — новых запросов нет. */
export const PpmSprintScale = observer(function PpmSprintScale() {
  const { workspaceSlug, projectId } = useParams();
  const router = useAppRouter();
  const { currentLocale } = useTranslation();
  const ppmT = usePpmTranslation();
  const { getProjectById } = useProject();
  const { getProjectCycleDetails } = useCycle();
  const slug = workspaceSlug?.toString();
  const pid = projectId?.toString();
  const project = getProjectById(pid);
  if (!slug || !pid || !project?.cycle_view) return null;
  const cycle = getProjectCycleDetails(pid)?.find((item) => item.status?.toLowerCase() === "current");
  if (!cycle) return null;
  const scale = computePpmSprintScale(cycle.start_date, cycle.end_date, new Date());
  const rangeLabel = formatPpmSprintRange(cycle.start_date, cycle.end_date, currentLocale);
  if (!scale || !rangeLabel) return null;
  const dayOfLabel = formatPpmTemplate(ppmT("tasks.sprint.day_of"), { day: scale.dayIndex, total: scale.totalDays });
  const daysLeftLabel =
    scale.daysLeft === 0
      ? ppmT("tasks.sprint.last_day")
      : formatPpmTemplate(ppmT(PPM_DAYS_LEFT_KEYS[selectPpmPluralKey(scale.daysLeft, currentLocale)]), {
          count: scale.daysLeft,
        });
  const href = `/${slug}/projects/${pid}/cycles/${cycle.id}`;
  return (
    <PpmSprintScaleView
      name={cycle.name}
      href={href}
      rangeLabel={rangeLabel}
      openLabel={ppmT("tasks.sprint.open")}
      scaleLabel={`${ppmT("tasks.sprint.scale_label")}: ${rangeLabel}, ${dayOfLabel.toLowerCase()}`}
      todayLabel={ppmT("tasks.sprint.today")}
      dayOfLabel={dayOfLabel}
      daysLeftLabel={daysLeftLabel}
      scale={scale}
      onOpen={() => router.push(href)}
    />
  );
});
