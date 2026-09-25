/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ReactNode } from "react";
import { CalendarClock, Check, MousePointerClick, PanelRightClose, PanelRightOpen } from "lucide-react";
import { handlePpmSpaClick } from "./format";
import { PpmBlockedGlyph } from "./task-evidence-view";

export type TPpmCuratorDetail = { prefix?: string; code?: string; suffix?: string };
export type TPpmCuratorEntry = {
  id: string;
  href: string;
  identifier: string;
  title: string;
  byline?: string;
  detail?: TPpmCuratorDetail;
};
export type TPpmRecentEntry = {
  id: string;
  href: string;
  identifier: string;
  title: string;
  initials: string;
  byline: string;
};
type TSection = { count: number; entries: TPpmCuratorEntry[]; moreLabel?: string };

export type TPpmCuratorViewProps = {
  labels: {
    title: string;
    hide: string;
    show: string;
    blocked: string;
    blockedEmpty: string;
    review: string;
    reviewEmpty: string;
    overdue: string;
    overdueEmpty: string;
    recent: string;
    recentEmpty: string;
    hint: string;
    loading: string;
    error: string;
    retry: string;
  };
  status: "loading" | "error" | "ready";
  collapsed: boolean;
  attentionCount: number;
  blocked: TSection;
  review: TSection | null;
  overdue: TSection & { nearest?: TPpmCuratorDetail };
  recent: TPpmRecentEntry[];
  partialNote?: string;
  onToggleCollapsed: () => void;
  onRetry: () => void;
  onOpenIssue: (issueId: string) => void;
};

function Detail({ detail, className }: { detail: TPpmCuratorDetail; className: string }) {
  return (
    <span className={className}>
      {detail.prefix}
      {detail.code && <span className="ppm-curator__code">{detail.code}</span>}
      {detail.suffix}
    </span>
  );
}

function Section(props: {
  title: string;
  section: TSection;
  empty: ReactNode;
  glyph: ReactNode;
  kind: "blocked" | "review" | "overdue";
  onOpenIssue: (issueId: string) => void;
}) {
  const { title, section, empty, glyph, kind, onOpenIssue } = props;
  return (
    <div className="ppm-curator__section">
      <h3 className="ppm-curator__section-title">
        {/* The space keeps «Заблокировано 1» two words for screen readers; the flex gap draws the visual space. */}
        {title} <span className="ppm-curator__code">{section.count}</span>
      </h3>
      {section.entries.length === 0
        ? empty
        : section.entries.map((entry) => (
            <a
              key={entry.id}
              href={entry.href}
              className="ppm-curator__item"
              onClick={(event) => handlePpmSpaClick(event, () => onOpenIssue(entry.id))}
            >
              <span aria-hidden="true" className="ppm-curator__glyph" data-kind={kind}>
                {glyph}
              </span>
              <span className="ppm-curator__body">
                <span className="ppm-curator__meta">
                  <span className="ppm-curator__code">{entry.identifier}</span>
                  {entry.byline && (
                    <>
                      <span aria-hidden="true">·</span>
                      {entry.byline}
                    </>
                  )}
                </span>
                <span className="ppm-curator__title">{entry.title}</span>
                {entry.detail && <Detail detail={entry.detail} className="ppm-curator__detail" />}
              </span>
            </a>
          ))}
      {section.moreLabel && <p className="ppm-curator__more">{section.moreLabel}</p>}
    </div>
  );
}

export function PpmCuratorColumnView(props: TPpmCuratorViewProps) {
  const { labels, status, collapsed, attentionCount, blocked, review, overdue, recent, partialNote } = props;
  const { onToggleCollapsed, onRetry, onOpenIssue } = props;

  if (collapsed)
    return (
      <aside
        aria-label={labels.title}
        className="ppm-curator ppm-curator--collapsed hidden flex-col items-center min-[1440px]:flex"
      >
        <button
          type="button"
          aria-label={labels.show}
          title={labels.show}
          aria-expanded={false}
          className="ppm-curator__icon-button"
          onClick={onToggleCollapsed}
        >
          <PanelRightOpen aria-hidden="true" className="size-4" strokeWidth={1.5} />
        </button>
        {status === "ready" && attentionCount > 0 && <span className="ppm-curator__code">{attentionCount}</span>}
      </aside>
    );

  return (
    <aside aria-label={labels.title} className="ppm-curator hidden flex-col min-[1440px]:flex">
      <div className="ppm-curator__head">
        <h2 className="ppm-curator__heading">{labels.title}</h2>
        {status === "ready" && <span className="ppm-curator__code">{attentionCount}</span>}
        <button
          type="button"
          aria-label={labels.hide}
          title={labels.hide}
          aria-expanded
          className="ppm-curator__icon-button ml-auto"
          onClick={onToggleCollapsed}
        >
          <PanelRightClose aria-hidden="true" className="size-4" strokeWidth={1.5} />
        </button>
      </div>

      {status === "loading" && <p className="ppm-curator__status">{labels.loading}</p>}
      {status === "error" && (
        <div className="ppm-curator__status">
          <p>{labels.error}</p>
          <button type="button" className="ppm-curator__retry" onClick={onRetry}>
            {labels.retry}
          </button>
        </div>
      )}
      {status === "ready" && (
        <>
          <div className="ppm-curator__sections">
            <Section
              title={labels.blocked}
              section={blocked}
              kind="blocked"
              glyph={<PpmBlockedGlyph className="size-4" />}
              empty={<p className="ppm-curator__empty">{labels.blockedEmpty}</p>}
              onOpenIssue={onOpenIssue}
            />
            {review && (
              <Section
                title={labels.review}
                section={review}
                kind="review"
                glyph={
                  <svg viewBox="0 0 14 14" fill="none" className="size-4">
                    <circle cx="7" cy="7" r="5.25" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M7 7V1.75A5.25 5.25 0 1 1 1.75 7Z" fill="currentColor" />
                  </svg>
                }
                empty={<p className="ppm-curator__empty">{labels.reviewEmpty}</p>}
                onOpenIssue={onOpenIssue}
              />
            )}
            <Section
              title={labels.overdue}
              section={overdue}
              kind="overdue"
              glyph={<CalendarClock className="size-4" strokeWidth={1.5} />}
              empty={
                <div className="ppm-curator__empty-row">
                  <Check aria-hidden="true" className="ppm-curator__ok size-4" strokeWidth={1.5} />
                  <span className="ppm-curator__body">
                    <span className="ppm-curator__empty-title">{labels.overdueEmpty}</span>
                    {overdue.nearest && <Detail detail={overdue.nearest} className="ppm-curator__detail" />}
                  </span>
                </div>
              }
              onOpenIssue={onOpenIssue}
            />
          </div>
          <span aria-hidden="true" className="ppm-curator__divider" />
          <h2 className="ppm-curator__recent-heading">{labels.recent}</h2>
          {recent.length === 0 ? (
            <p className="ppm-curator__empty ppm-curator__empty--recent">{labels.recentEmpty}</p>
          ) : (
            <ol className="ppm-curator__recent">
              {recent.map((entry) => (
                <li key={entry.id}>
                  <a
                    href={entry.href}
                    className="ppm-curator__item"
                    onClick={(event) => handlePpmSpaClick(event, () => onOpenIssue(entry.id))}
                  >
                    <span aria-hidden="true" className="ppm-curator__avatar">
                      {entry.initials}
                    </span>
                    <span className="ppm-curator__body">
                      <span className="ppm-curator__recent-title">
                        <span className="ppm-curator__code">{entry.identifier}</span>
                        <span aria-hidden="true"> · </span>
                        {entry.title}
                      </span>
                      <span className="ppm-curator__detail">{entry.byline}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ol>
          )}
          {partialNote && <p className="ppm-curator__more">{partialNote}</p>}
        </>
      )}

      <p className="ppm-curator__foot">
        <MousePointerClick aria-hidden="true" className="size-3.5 flex-none" strokeWidth={1.5} />
        <span>{labels.hint}</span>
      </p>
    </aside>
  );
}
