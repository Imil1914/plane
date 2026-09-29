/**
 * Copyright (c) 2026 PPM contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// G2.2 (R18/R19): the admin center's «Git-сервер» tab — reachable only by a PPM global administrator (the whole
// center is already gated by `PpmAdminCenter` before any tab renders, `admin-center.tsx`). Shows whether our Git
// server and single sign-on are configured, the last full reconciliation, its numbers and recent problems, a manual
// «Синхронизировать сейчас», and a link to Forgejo's own admin panel. No secrets ever reach this screen (the API
// contract carries none — `plan.md`).
import { useState } from "react";
import { CheckCircle2, ExternalLink, RefreshCw, XCircle } from "lucide-react";
import useSWR from "swr";
import { Button } from "@plane/propel/button";
import { safeGitWebUrl } from "@/components/ppm-git/git-provider-labels";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { PpmAdminService, PpmAdminServiceError, type TPpmAdminGitServerProblem } from "@/services/ppm-admin.service";
import {
  formatCount,
  GIT_SERVER_COUNT_FIELDS,
  getProblemKindLabelKey,
  getSyncDurationSeconds,
  getSyncStatusLabelKey,
  isUuidLike,
} from "./ppm-git-server-status.helper";
import { EmptyState, LoadingState } from "./shared-states";

const adminService = new PpmAdminService();

function formatDateTime(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function StatusPill({ offLabel, ok, onLabel }: { offLabel: string; ok: boolean; onLabel: string }) {
  const Icon = ok ? CheckCircle2 : XCircle;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-11 font-semibold ${
        ok ? "bg-success-subtle text-success-primary" : "bg-danger-subtle text-danger-primary"
      }`}
    >
      <Icon className="size-3.5" aria-hidden="true" /> {ok ? onLabel : offLabel}
    </span>
  );
}

function ProblemRow({ problem }: { problem: TPpmAdminGitServerProblem }) {
  const ppmT = usePpmTranslation();
  const kindLabelKey = getProblemKindLabelKey(problem.kind);
  // Round 1 (#6): translated kind, in Russian; a raw id never appears here (the message below already carries the
  // human explanation) — only a readable subject (an email, a username, a slug) is shown next to it.
  const kindLabel = kindLabelKey ? ppmT(kindLabelKey) : problem.kind;
  const subject = isUuidLike(problem.subject) ? null : problem.subject;
  return (
    <li className="rounded-lg border border-subtle bg-layer-1 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-11 font-semibold text-primary">
          {kindLabel}
          {subject ? ` · ${subject}` : ""}
        </span>
        <time className="text-11 text-tertiary" dateTime={problem.at}>
          {formatDateTime(problem.at)}
        </time>
      </div>
      <p className="mt-1 text-12 leading-5 text-secondary">{problem.message}</p>
    </li>
  );
}

export function GitServerPanel() {
  const ppmT = usePpmTranslation();
  const { data, error, isLoading, mutate } = useSWR("ppm-admin-git-server-status", () =>
    adminService.getGitServerStatus()
  );
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<{ isError: boolean; text: string } | null>(null);

  const syncNow = async () => {
    setSyncing(true);
    setSyncMessage(null);
    try {
      await adminService.syncGitServerNow();
      setSyncMessage({ isError: false, text: ppmT("g22.admin.git_sync_scheduled") });
      await mutate();
    } catch (reason) {
      const retryAfter = reason instanceof PpmAdminServiceError ? reason.retryAfterSeconds : undefined;
      const text =
        retryAfter !== undefined
          ? ppmT("g22.admin.git_sync_retry_after").replace("{seconds}", String(retryAfter))
          : reason instanceof PpmAdminServiceError
            ? reason.message
            : ppmT("g22.admin.git_sync_error");
      setSyncMessage({ isError: true, text });
    } finally {
      setSyncing(false);
    }
  };

  if (isLoading) return <LoadingState />;
  if (error || !data) {
    return (
      <div className="flex min-h-72 flex-col items-center justify-center rounded-xl border border-subtle bg-surface-2 p-8 text-center">
        <XCircle className="size-8 text-danger-primary" aria-hidden="true" />
        <p className="mt-3 text-16 font-semibold text-primary">{ppmT("g22.admin.git_error")}</p>
        <Button className="mt-4" variant="secondary" onClick={() => void mutate()}>
          {ppmT("g22.admin.git_retry")}
        </Button>
      </div>
    );
  }

  const durationSeconds = getSyncDurationSeconds(data.last_full_sync?.started_at, data.last_full_sync?.finished_at);
  const statusKey = data.last_full_sync ? getSyncStatusLabelKey(data.last_full_sync.status) : undefined;
  // Round 1 (#6): never link an address the API did not actually send as http(s) — same guard the «Код» page uses
  // for every other Git-server link.
  const forgejoAdminUrl = safeGitWebUrl(data.forgejo_admin_url);

  return (
    <section className="grid gap-4">
      <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-16 font-semibold text-primary">{ppmT("g22.admin.git_tab")}</h2>
            <p className="mt-1 max-w-2xl text-13 leading-6 text-secondary">{ppmT("g22.admin.git_description")}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <StatusPill
                ok={data.configured}
                onLabel={ppmT("g22.admin.git_configured")}
                offLabel={ppmT("g22.admin.git_not_configured")}
              />
              <StatusPill
                ok={data.reachable}
                onLabel={ppmT("g22.admin.git_reachable")}
                offLabel={ppmT("g22.admin.git_unreachable")}
              />
              <StatusPill
                ok={data.sso_enabled}
                onLabel={ppmT("g22.admin.git_sso_on")}
                offLabel={ppmT("g22.admin.git_sso_off")}
              />
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <Button variant="primary" loading={syncing} onClick={() => void syncNow()}>
              <RefreshCw className="mr-1.5 size-3.5" aria-hidden="true" /> {ppmT("g22.admin.git_sync_now")}
            </Button>
            {forgejoAdminUrl && (
              <a
                className="inline-flex items-center gap-1 text-12 font-semibold text-accent-primary hover:underline"
                href={forgejoAdminUrl}
                target="_blank"
                rel="noreferrer"
              >
                {ppmT("g22.admin.git_open_admin")} <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            )}
          </div>
        </div>
        {syncMessage && (
          <p
            className={`mt-3 text-12 ${syncMessage.isError ? "text-danger-primary" : "text-success-primary"}`}
            role={syncMessage.isError ? "alert" : "status"}
          >
            {syncMessage.text}
          </p>
        )}
      </div>

      <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
        <h3 className="text-14 font-semibold text-primary">{ppmT("g22.admin.git_last_sync_title")}</h3>
        {!data.last_full_sync ? (
          <p className="mt-2 text-13 text-secondary">{ppmT("g22.admin.git_last_sync_never")}</p>
        ) : (
          <>
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-13 text-secondary">
              <time dateTime={data.last_full_sync.started_at}>{formatDateTime(data.last_full_sync.started_at)}</time>
              {statusKey && <span className="font-semibold text-primary">{ppmT(statusKey)}</span>}
              {durationSeconds !== null && (
                <span>{ppmT("g22.admin.git_sync_duration_seconds").replace("{seconds}", String(durationSeconds))}</span>
              )}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
              {GIT_SERVER_COUNT_FIELDS.map(({ key, labelKey }) => (
                <div key={key} className="rounded-lg border border-subtle bg-layer-1 p-3 text-center">
                  {/* Round 2: null means "not known yet", not zero — formatCount shows "—" for it. */}
                  <p className="text-20 font-semibold text-primary">{formatCount(data.last_full_sync?.counts[key])}</p>
                  <p className="mt-1 text-11 text-tertiary">{ppmT(labelKey)}</p>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
        <h3 className="text-14 font-semibold text-primary">{ppmT("g22.admin.git_problems_title")}</h3>
        {data.problems.length === 0 ? (
          <div className="mt-3">
            <EmptyState message={ppmT("g22.admin.git_no_problems")} />
          </div>
        ) : (
          <ul className="mt-3 grid gap-2">
            {data.problems.map((problem) => (
              <ProblemRow key={`${problem.at}-${problem.kind}-${problem.subject}`} problem={problem} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
