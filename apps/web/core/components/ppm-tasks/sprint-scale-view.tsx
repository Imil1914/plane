/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { handlePpmSpaClick } from "./format";
import type { TPpmSprintScale } from "./sprint";

export type TPpmSprintScaleViewProps = {
  name: string;
  href: string;
  rangeLabel: string;
  openLabel: string;
  scaleLabel: string;
  todayLabel: string;
  dayOfLabel: string;
  daysLeftLabel: string;
  scale: TPpmSprintScale;
  onOpen: () => void;
};

const toPercent = (value: number) => `${(value * 100).toFixed(3)}%`;

export function PpmSprintScaleView(props: TPpmSprintScaleViewProps) {
  const { name, href, rangeLabel, openLabel, scaleLabel, todayLabel, dayOfLabel, daysLeftLabel, scale, onOpen } = props;
  // «16–29 сент.» уже кончается точкой — вторую не ставим
  const linkLabel = `${name}, ${rangeLabel.replace(/\.?$/, ".")} ${openLabel}`;
  return (
    <section aria-label={name} className="ppm-sprint">
      <a
        href={href}
        aria-label={linkLabel}
        className="ppm-sprint__name"
        onClick={(event) => handlePpmSpaClick(event, onOpen)}
      >
        <span className="ppm-sprint__title">{name}</span>
        <span className="ppm-sprint__range">{rangeLabel}</span>
      </a>
      <div className="ppm-sprint__track" role="img" aria-label={scaleLabel}>
        <span aria-hidden="true" className="ppm-sprint__elapsed" style={{ width: toPercent(scale.todayPosition) }} />
        <span aria-hidden="true" className="ppm-sprint__axis" />
        {scale.ticks.map((tick) => (
          <span
            key={tick.key}
            aria-hidden="true"
            className="ppm-sprint__tick"
            data-major={tick.isMajor ? "true" : undefined}
            style={{ left: toPercent(tick.position) }}
          />
        ))}
        {scale.ticks
          .filter((tick) => tick.showLabel)
          .map((tick) => (
            <span
              key={`label-${tick.key}`}
              aria-hidden="true"
              className="ppm-sprint__label"
              data-today={tick.isToday ? "true" : undefined}
              style={{ left: toPercent(tick.position) }}
            >
              {tick.label}
            </span>
          ))}
        <span aria-hidden="true" className="ppm-sprint__today" style={{ left: toPercent(scale.todayPosition) }}>
          <span className="ppm-sprint__today-label">{todayLabel}</span>
        </span>
      </div>
      <div className="ppm-sprint__summary">
        <div className="ppm-sprint__day">{dayOfLabel}</div>
        <div className="ppm-sprint__left">{daysLeftLabel}</div>
      </div>
    </section>
  );
}
