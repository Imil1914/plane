/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { GitPullRequest, Paperclip } from "lucide-react";

/** Засечка ⊣ — тот же знак, что конец линии «Блокирует» на Холсте (TOKENS §9 п.4). */
export function PpmBlockedGlyph({ className = "size-3" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      className={className}
    >
      <path d="M2.75 8h9.5" />
      <path d="M12.25 4.5v7" />
    </svg>
  );
}

export type TPpmEvidenceViewProps = {
  pullRequest: { label: string; srLabel: string; more: number; titles: string } | null;
  materials: { count: number; srLabel: string; title: string } | null;
};

/** Внутри строки-ссылки (ControlLink = <a>) — только текст, без вложенных ссылок. */
export function PpmTaskEvidenceView({ pullRequest, materials }: TPpmEvidenceViewProps) {
  if (!pullRequest && !materials) return null;
  return (
    <span className="ppm-task-evidence">
      {pullRequest && (
        <span className="ppm-task-evidence__item" title={pullRequest.titles}>
          <span className="sr-only">{pullRequest.srLabel}</span>
          <GitPullRequest aria-hidden="true" className="ppm-task-evidence__icon--pr size-3.5" strokeWidth={1.5} />
          <span aria-hidden="true">{pullRequest.label}</span>
          {pullRequest.more > 0 && <span aria-hidden="true">{`+${pullRequest.more}`}</span>}
        </span>
      )}
      {materials && (
        <span className="ppm-task-evidence__item" title={materials.title}>
          <span className="sr-only">{materials.srLabel}</span>
          <Paperclip aria-hidden="true" className="ppm-task-evidence__icon size-3.5" strokeWidth={1.5} />
          <span aria-hidden="true">{materials.count}</span>
        </span>
      )}
    </span>
  );
}

export type TPpmBlockedMarkerViewProps = { srText: string; identifier: string; more: number; title: string };

export function PpmTaskBlockedMarkerView({ srText, identifier, more, title }: TPpmBlockedMarkerViewProps) {
  return (
    <span className="ppm-task-blocked" title={title}>
      <span className="sr-only">{srText}</span>
      <span aria-hidden="true" className="inline-flex items-center gap-1">
        <PpmBlockedGlyph />
        {identifier}
        {more > 0 && <span>{`+${more}`}</span>}
      </span>
    </span>
  );
}
