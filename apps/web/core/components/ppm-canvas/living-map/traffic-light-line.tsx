/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { ArrowRightToLine, Clock } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { fillCanvasTemplate, formatDueDate } from "../canvas-grammar";
import type { TWorkItemFacts } from "./living-map-types";

// AF2.2 M3: строка «Светофора» над подвалом живой карточки задачи (K5): «заблокирована ROBOT-12» / «просрочено · 20 сент.».
export function PpmTrafficLine({ facts }: { facts: TWorkItemFacts }) {
  const ppmT = usePpmTranslation();
  const { currentLocale } = useTranslation();
  if (facts.traffic === "blocked") {
    const first = facts.blockedBy[0]?.identifier;
    return (
      <p className="ppm-traffic-line" data-tone="blocked">
        <ArrowRightToLine aria-hidden="true" />
        {first
          ? fillCanvasTemplate(ppmT("canvas.traffic.blocked_line"), { id: first })
          : ppmT("canvas.traffic.blocked_unknown")}
      </p>
    );
  }
  if (facts.traffic === "overdue" && facts.dueDate)
    return (
      <p className="ppm-traffic-line" data-tone="overdue">
        <Clock aria-hidden="true" />
        {fillCanvasTemplate(ppmT("canvas.traffic.overdue_line"), { date: formatDueDate(facts.dueDate, currentLocale) })}
      </p>
    );
  return null;
}
