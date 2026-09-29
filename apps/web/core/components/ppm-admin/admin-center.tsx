/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useDeferredValue, useState } from "react";
import type { FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BrainCircuit,
  Code2,
  ExternalLink,
  FolderKanban,
  HardDrive,
  LayoutDashboard,
  LockKeyhole,
  ScrollText,
  Search,
  Server,
  ShieldCheck,
  UserCheck,
  UserX,
  Users,
} from "lucide-react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { Button } from "@plane/propel/button";
import { Input } from "@plane/ui";
import type { TPpmTranslationKey } from "@ppm/brand";
import { PageHead } from "@/components/core/page-title";
import { usePpmConfirm, type TPpmConfirm } from "@/components/ppm-shell/use-ppm-confirm";
import { usePpmAdminAccess } from "@/hooks/use-ppm-admin-access";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import {
  PpmAdminService,
  PpmAdminServiceError,
  type TPpmAdminAudit,
  type TPpmAdminProject,
  type TPpmAdminUser,
} from "@/services/ppm-admin.service";
import { GitServerPanel } from "./git-server-panel";
import { EmptyState, ErrorState, LoadingState } from "./shared-states";
import {
  USER_STATUS_LABEL_KEYS,
  getUserAction,
  getUserActionConfirm,
  getUserName,
  getUserStatus,
} from "./user-suspension.helper";

const adminService = new PpmAdminService();

type TAdminTab = "projects" | "users" | "audit" | "git";

const STATUS_KEYS: Record<string, TPpmTranslationKey> = {
  ready: "admin.status_ready",
  empty: "admin.status_empty",
  not_created: "admin.status_not_created",
  not_configured: "admin.status_not_configured",
  active: "admin.status_active",
  archived: "admin.status_archived",
};

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function Pagination({ page, hasNext, onChange }: { page: number; hasNext: boolean; onChange: (page: number) => void }) {
  const ppmT = usePpmTranslation();
  return (
    <div className="flex items-center justify-end gap-2 pt-4">
      <Button variant="secondary" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        <ArrowLeft className="mr-1 size-3.5" aria-hidden="true" />
        {ppmT("admin.previous")}
      </Button>
      <span className="px-2 text-12 text-secondary">
        {ppmT("admin.page")} {page}
      </span>
      <Button variant="secondary" disabled={!hasNext} onClick={() => onChange(page + 1)}>
        {ppmT("admin.next")}
        <ArrowRight className="ml-1 size-3.5" aria-hidden="true" />
      </Button>
    </div>
  );
}

function IntegrationBadge({
  icon: Icon,
  label,
  status,
  detail,
}: {
  icon: typeof LayoutDashboard;
  label: string;
  status: string;
  detail?: string;
}) {
  const ppmT = usePpmTranslation();
  const isReady = status === "ready";
  return (
    <div className="flex min-w-32 items-center gap-2 rounded-lg border border-subtle bg-layer-1 px-2.5 py-2">
      <Icon className={`size-4 ${isReady ? "text-success-primary" : "text-tertiary"}`} aria-hidden="true" />
      <div className="min-w-0">
        <p className="truncate text-11 font-medium text-primary">{label}</p>
        <p className="truncate text-11 text-secondary">
          {STATUS_KEYS[status] ? ppmT(STATUS_KEYS[status]) : status}
          {detail ? ` · ${detail}` : ""}
        </p>
      </div>
    </div>
  );
}

function ProjectRow({ project }: { project: TPpmAdminProject }) {
  const ppmT = usePpmTranslation();
  const router = useRouter();
  const [isOpening, setIsOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const openProject = async () => {
    setIsOpening(true);
    setOpenError(null);
    try {
      const result = await adminService.enterProject(project.project_id);
      router.push(result.navigation_url);
    } catch (error) {
      setOpenError(error instanceof PpmAdminServiceError ? error.message : ppmT("admin.error"));
    } finally {
      setIsOpening(false);
    }
  };

  return (
    <article className="rounded-xl border border-subtle bg-surface-2 p-4">
      <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-start">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="rounded bg-layer-1 px-2 py-1 font-code text-11 text-secondary">{project.identifier}</span>
            <span className="text-11 font-semibold tracking-wide text-tertiary uppercase">
              {STATUS_KEYS[project.status] ? ppmT(STATUS_KEYS[project.status]) : project.status}
            </span>
          </div>
          <h2 className="mt-2 truncate text-16 font-semibold text-primary">{project.name}</h2>
          <p className="mt-1 text-12 text-secondary">
            {ppmT("admin.workspace")}: {project.workspace.name} · {project.member_count} {ppmT("admin.member_count")}
          </p>
          <p className="mt-1 text-12 text-secondary">
            {ppmT("admin.project_lead")}: {project.lead?.display_name || ppmT("admin.no_lead")}
          </p>
        </div>
        <Button variant="primary" loading={isOpening} onClick={openProject}>
          <ExternalLink className="mr-1.5 size-3.5" aria-hidden="true" />
          {ppmT("admin.open_project")}
        </Button>
      </div>
      {openError && <p className="mt-2 text-12 text-danger-primary">{openError}</p>}
      <div className="mt-4">
        <p className="mb-2 text-11 font-semibold tracking-wide text-tertiary uppercase">{ppmT("admin.integrations")}</p>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <IntegrationBadge
            icon={LayoutDashboard}
            label={ppmT("admin.canvas")}
            status={project.integrations.canvas.status}
            detail={`${project.integrations.canvas.active_boards ?? 0}`}
          />
          <IntegrationBadge icon={HardDrive} label={ppmT("admin.vault")} status={project.integrations.vault.status} />
          <IntegrationBadge
            icon={BrainCircuit}
            label={ppmT("admin.brain")}
            status={project.integrations.brain.status}
          />
          <IntegrationBadge icon={Code2} label={ppmT("admin.git")} status={project.integrations.git.status} />
        </div>
      </div>
    </article>
  );
}

function ProjectsPanel() {
  const ppmT = usePpmTranslation();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const [page, setPage] = useState(1);
  const { data, error, isLoading, mutate } = useSWR(["ppm-admin-projects", deferredSearch, page], () =>
    adminService.getProjects(deferredSearch, page)
  );

  return (
    <section>
      <div className="relative mb-4 max-w-xl">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-tertiary" />
        <Input
          className="w-full pl-9"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          placeholder={ppmT("admin.search_projects")}
        />
      </div>
      {isLoading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState onRetry={() => void mutate()} />
      ) : data?.results.length ? (
        <>
          <div className="grid gap-3 xl:grid-cols-2">
            {data.results.map((project) => (
              <ProjectRow key={project.project_id} project={project} />
            ))}
          </div>
          <Pagination page={page} hasNext={data.pagination.has_next} onChange={setPage} />
        </>
      ) : (
        <EmptyState message={ppmT("admin.no_projects")} />
      )}
    </section>
  );
}

function UserRow({
  user,
  confirm,
  gitServerSso,
  onChanged,
}: {
  user: TPpmAdminUser;
  confirm: TPpmConfirm;
  gitServerSso: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const ppmT = usePpmTranslation();
  const [isSaving, setIsSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const status = getUserStatus(user);
  // G2.2 R15a: «Отключить» / «Включить» only where the API allows it (never oneself, a global or instance
  // administrator, a service account, or a person who deactivated their own account).
  const action = getUserAction(user);

  const runAction = async () => {
    if (!action || !(await confirm(getUserActionConfirm(action, getUserName(user), ppmT, gitServerSso)))) return;
    setIsSaving(true);
    setActionError(null);
    try {
      await (action === "suspend" ? adminService.suspendUser(user.user_id) : adminService.resumeUser(user.user_id));
      await onChanged();
    } catch (error) {
      // A refusal of the API (4xx) explains itself in Russian; a server or network failure gets the action's own text.
      const refusal = error instanceof PpmAdminServiceError && (error.status ?? 500) < 500 ? error.message : null;
      setActionError(refusal ?? ppmT(action === "suspend" ? "g22.users.suspend_error" : "g22.users.resume_error"));
      // Someone changed the person meanwhile (409) or the person is gone (404): show the list as it is now.
      if (error instanceof PpmAdminServiceError && (error.status === 404 || error.status === 409)) void onChanged();
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="grid gap-3 rounded-xl border border-subtle bg-surface-2 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-14 font-semibold text-primary">{user.display_name || user.email}</p>
          {user.is_global_admin && (
            <span className="rounded-full bg-accent-primary/15 px-2 py-0.5 text-11 font-semibold text-accent-primary">
              {ppmT("admin.global_admin")}
            </span>
          )}
          <span
            className={`text-11 font-semibold ${status === "active" ? "text-success-primary" : "text-danger-primary"}`}
          >
            {ppmT(USER_STATUS_LABEL_KEYS[status])}
            {status === "suspended" && user.suspended_at
              ? ` ${ppmT("g22.users.suspended_since").replace("{date}", formatDate(user.suspended_at))}`
              : ""}
          </span>
        </div>
        <p className="mt-1 truncate text-12 text-secondary">{user.email || "—"}</p>
        {actionError && (
          <p className="mt-1 text-12 text-danger-primary" role="alert">
            {actionError}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-5 text-12 text-secondary">
        <span>
          {ppmT("admin.workspace_count")}: <strong className="text-primary">{user.workspace_count}</strong>
        </span>
        <span>
          {ppmT("admin.project_count")}: <strong className="text-primary">{user.project_count}</strong>
        </span>
        {action && (
          <Button
            variant={action === "suspend" ? "error-outline" : "secondary"}
            loading={isSaving}
            onClick={() => void runAction()}
          >
            {action === "suspend" ? (
              <UserX className="mr-1.5 size-3.5" aria-hidden="true" />
            ) : (
              <UserCheck className="mr-1.5 size-3.5" aria-hidden="true" />
            )}
            {ppmT(action === "suspend" ? "g22.users.suspend" : "g22.users.resume")}
          </Button>
        )}
      </div>
    </div>
  );
}

function UsersPanel() {
  const ppmT = usePpmTranslation();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const [page, setPage] = useState(1);
  const { data, error, isLoading, mutate } = useSWR(["ppm-admin-users", deferredSearch, page], () =>
    adminService.getUsers(deferredSearch, page)
  );
  const { confirm, confirmDialog } = usePpmConfirm();
  // G2.2 R15a: the confirmation names the Git server only while single sign-on is on there — the status of the
  // «Git-сервер» tab (same SWR key, shared cache); unknown or failed → PPM only.
  const { data: gitServer } = useSWR("ppm-admin-git-server-status", () => adminService.getGitServerStatus(), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
  const gitServerSso = gitServer?.sso_enabled === true;
  return (
    <section>
      <div className="relative mb-4 max-w-xl">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-tertiary" />
        <Input
          className="w-full pl-9"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          placeholder={ppmT("admin.search_users")}
        />
      </div>
      {isLoading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState onRetry={() => void mutate()} />
      ) : data?.results.length ? (
        <>
          <div className="grid gap-2">
            {data.results.map((user) => (
              <UserRow
                key={user.user_id}
                user={user}
                confirm={confirm}
                gitServerSso={gitServerSso}
                onChanged={() => mutate()}
              />
            ))}
          </div>
          <Pagination page={page} hasNext={data.pagination.has_next} onChange={setPage} />
        </>
      ) : (
        <EmptyState message={ppmT("admin.no_users")} />
      )}
      {confirmDialog}
    </section>
  );
}

function AuditRow({ event }: { event: TPpmAdminAudit }) {
  return (
    <div className="grid gap-2 rounded-xl border border-subtle bg-surface-2 p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
      <div className="min-w-0">
        <p className="font-code text-12 font-semibold text-primary">{event.action}</p>
        <p className="mt-1 truncate text-12 text-secondary">
          {event.actor.display_name || event.actor.email} · {event.method} {event.path}
        </p>
      </div>
      <time className="text-11 text-tertiary" dateTime={event.created_at}>
        {formatDate(event.created_at)}
      </time>
    </div>
  );
}

function AuditPanel() {
  const ppmT = usePpmTranslation();
  const [page, setPage] = useState(1);
  const { data, error, isLoading, mutate } = useSWR(["ppm-admin-audit", page], () => adminService.getAudit(page));
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState onRetry={() => void mutate()} />;
  if (!data?.results.length) return <EmptyState message={ppmT("admin.no_audit")} />;
  return (
    <section>
      <div className="grid gap-2">
        {data.results.map((event) => (
          <AuditRow key={event.audit_id} event={event} />
        ))}
      </div>
      <Pagination page={page} hasNext={data.pagination.has_next} onChange={setPage} />
    </section>
  );
}

function ReauthenticationCard({
  reauthenticatedUntil,
  onConfirmed,
}: {
  reauthenticatedUntil: string | null;
  onConfirmed: () => void;
}) {
  const ppmT = usePpmTranslation();
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setIsSubmitting(true);
    setMessage(null);
    try {
      await adminService.reauthenticate(password);
      setPassword("");
      setIsError(false);
      setMessage(ppmT("admin.reauth_success"));
      onConfirmed();
    } catch (error) {
      setIsError(true);
      setMessage(error instanceof PpmAdminServiceError ? error.message : ppmT("admin.reauth_error"));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="rounded-xl border border-subtle bg-surface-2 p-4">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-accent-primary/15 p-2 text-accent-primary">
          <LockKeyhole className="size-4" aria-hidden="true" />
        </div>
        <div>
          <h2 className="text-13 font-semibold text-primary">{ppmT("admin.reauth_title")}</h2>
          <p className="mt-1 text-12 leading-5 text-secondary">{ppmT("admin.reauth_description")}</p>
          {reauthenticatedUntil && (
            <p className="mt-1 text-12 font-medium text-success-primary">
              {ppmT("admin.confirmed_until")}: {formatDate(reauthenticatedUntil)}
            </p>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Input
          className="min-w-0 flex-1"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder={ppmT("admin.password")}
        />
        <Button type="submit" variant="secondary" disabled={!password} loading={isSubmitting}>
          {ppmT("admin.confirm")}
        </Button>
      </div>
      {message && (
        <p className={`mt-2 text-12 ${isError ? "text-danger-primary" : "text-success-primary"}`}>{message}</p>
      )}
    </form>
  );
}

export function PpmAdminCenter() {
  const ppmT = usePpmTranslation();
  const [tab, setTab] = useState<TAdminTab>("projects");
  const { data: access, error, isLoading, mutate } = usePpmAdminAccess();

  if (isLoading) return <LoadingState />;

  if (error) {
    return (
      <main className="min-h-screen bg-canvas p-6">
        <div className="mx-auto max-w-7xl">
          <ErrorState onRetry={() => void mutate()} />
        </div>
      </main>
    );
  }

  if (!access?.is_global_admin) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-canvas p-6">
        <PageHead title={ppmT("admin.access_denied")} />
        <div className="max-w-lg rounded-2xl border border-subtle bg-surface-2 p-8 text-center shadow-raised-100">
          <ShieldCheck className="mx-auto size-10 text-tertiary" aria-hidden="true" />
          <h1 className="mt-4 text-20 font-semibold text-primary">{ppmT("admin.access_denied")}</h1>
          <p className="mt-2 text-13 leading-6 text-secondary">{ppmT("admin.access_denied_description")}</p>
        </div>
      </main>
    );
  }

  const tabs: { id: TAdminTab; label: string; icon: typeof FolderKanban }[] = [
    { id: "projects", label: ppmT("admin.projects"), icon: FolderKanban },
    { id: "users", label: ppmT("admin.users"), icon: Users },
    { id: "audit", label: ppmT("admin.audit"), icon: ScrollText },
    // G2.2 (R18): global administrators only — inherited for free, the whole center is already gated above.
    { id: "git", label: ppmT("g22.admin.git_tab"), icon: Server },
  ];

  return (
    <main className="min-h-screen bg-canvas px-4 py-6 sm:px-6 lg:px-8">
      <PageHead title={ppmT("admin.title")} />
      <div className="mx-auto max-w-7xl">
        <header className="rounded-2xl border border-subtle bg-surface-2 p-5 sm:p-6">
          <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full bg-accent-primary/15 px-2.5 py-1 text-11 font-semibold text-accent-primary">
                <ShieldCheck className="size-3.5" aria-hidden="true" />
                {ppmT("admin.protected_role")}
              </div>
              <h1 className="mt-3 text-24 font-semibold tracking-tight text-primary">{ppmT("admin.title")}</h1>
              <p className="mt-2 max-w-2xl text-13 leading-6 text-secondary">{ppmT("admin.description")}</p>
            </div>
            <div className="w-full lg:max-w-md">
              <ReauthenticationCard
                reauthenticatedUntil={access.reauthenticated_until}
                onConfirmed={() => void mutate()}
              />
            </div>
          </div>
        </header>

        <nav
          className="my-5 flex gap-1 overflow-x-auto rounded-xl border border-subtle bg-surface-2 p-1"
          aria-label={ppmT("admin.center")}
        >
          {tabs.map((item) => {
            const Icon = item.icon;
            const isActive = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`flex min-w-max items-center gap-2 rounded-lg px-4 py-2.5 text-13 font-medium transition-colors ${
                  isActive
                    ? "bg-layer-1-selected text-primary"
                    : "text-secondary hover:bg-layer-1-hover hover:text-primary"
                }`}
              >
                <Icon className="size-4" aria-hidden="true" />
                {item.label}
              </button>
            );
          })}
        </nav>

        {tab === "projects" && <ProjectsPanel />}
        {tab === "users" && <UsersPanel />}
        {tab === "audit" && <AuditPanel />}
        {tab === "git" && <GitServerPanel />}
      </div>
    </main>
  );
}
