import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Dialog } from "@headlessui/react";
import {
  Code2,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Github,
  Link2,
  LoaderCircle,
  Plus,
  Search,
  ShieldCheck,
  Unlink,
  X,
} from "lucide-react";
import Link from "next/link";
import { EModalWidth, ModalCore } from "@plane/ui";
import type { TPpmWorkItemProjection } from "@ppm/canvas";
import { PageHead } from "@/components/core/page-title";
import { usePpmConfirm } from "@/components/ppm-shell/use-ppm-confirm";
import { handlePpmDialogKeyDown, shouldDismissPpmDialog } from "@/helpers/ppm-dialog-dismiss.helper";
import { safeGithubUrl, type TPpmGitWriteCommand } from "@/helpers/ppm-git-write-flow.helper";
import { useProject } from "@/hooks/store/use-project";
import { useWorkspace } from "@/hooks/store/use-workspace";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { PpmCanvasService } from "@/services/ppm-canvas.service";
import {
  PpmGitService,
  PpmGitServiceError,
  type TPpmGitLink,
  type TPpmGitLinkRequest,
  type TPpmGitConnection,
  type TPpmGitHubRepository,
  type TPpmGitObject,
  type TPpmGitObjectType,
  type TPpmGitOverview,
  type TPpmGitProvider,
  type TPpmGitRepository,
  type TPpmGitRepositoryRequest,
  type TPpmGitWriteAction,
  type TPpmGitWriteActionRequest,
} from "@/services/ppm-git.service";
import { ForgejoProviderPanel, ForgejoRepositoryPicker, useForgejoRepositoryPicker } from "./forgejo-connect";
import type { TForgejoPickerDeps } from "./forgejo-repository-picker";
import { copyTextToClipboard } from "./git-clipboard";
import { DialogActions, FormInput } from "./git-dialog-parts";
import {
  getActiveGithubInstallation,
  getActiveGithubRepositories,
  getGitPullRequestStatusLabel,
  getGitSecurityNote,
  getPpmGitServer,
  PPM_GIT_MANUAL_PROVIDERS,
  PPM_GIT_PROVIDER_LABELS,
  splitGitConnectionsByProvider,
} from "./git-provider-labels";
import { GitConnectionRow, PPM_GIT_VISIBILITY_LABELS, RepositoryCard } from "./git-section-parts";
import {
  GitWriteActionDetails,
  GitWriteActionsPanel,
  GitWriteBranchForm,
  GitWritePullRequestForm,
  type TPpmGitWriteDialogError,
  type TPpmGitWriteForm,
  type TPpmGitWriteWorkItem,
} from "./git-write-flow";

type TPpmGitRouteProps = {
  projectId: string;
  workspaceSlug: string;
};

const OBJECT_LABELS: Record<TPpmGitObjectType, string> = {
  branch: "Ветка",
  commit: "Коммит",
  pull_request: "Запрос на слияние (PR)",
};

const OBJECT_ICONS = {
  branch: GitBranch,
  commit: GitCommitHorizontal,
  pull_request: GitPullRequest,
} as const;

const EMPTY_REPOSITORY: TPpmGitRepositoryRequest = {
  name: "",
  provider: "github",
  canonical_url: "",
  clone_https: "",
  clone_ssh: "",
  default_branch: "main",
  visibility: "unknown",
  is_default: false,
};

const EMPTY_LINK: Omit<TPpmGitLinkRequest, "repository_id" | "work_item_id"> = {
  object_type: "pull_request",
  ref: "",
  title: "",
  canonical_url: "",
};

const EMPTY_WRITE_ACTION: TPpmGitWriteForm = {
  base_ref: "main",
  head_ref: "",
  title: "",
  body: "",
};

// G1.3 (RC-C): step 1 form (branch), step 2 form (draft PR after the first push), or one step's preview/decision.
type TGitWriteDialog =
  | { mode: "branch_form" }
  | { mode: "pull_request_form"; parent: TPpmGitWriteAction }
  | { mode: "action"; action: TPpmGitWriteAction };

export function PpmGitRoute({ projectId, workspaceSlug }: TPpmGitRouteProps) {
  const { getPartialProjectById } = useProject();
  const { getWorkspaceBySlug } = useWorkspace();
  const project = getPartialProjectById(projectId);
  const workspace = getWorkspaceBySlug(workspaceSlug);
  const service = useMemo(() => new PpmGitService(), []);
  const canvasService = useMemo(() => new PpmCanvasService(), []);
  const ppmT = usePpmTranslation();
  const { confirm, confirmDialog } = usePpmConfirm();
  const [overview, setOverview] = useState<TPpmGitOverview>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState<string>();
  const [repositoryDialog, setRepositoryDialog] = useState(false);
  const [githubDialog, setGithubDialog] = useState(false);
  const [gitServerDialog, setGitServerDialog] = useState(false);
  const [githubRepositories, setGithubRepositories] = useState<TPpmGitHubRepository[]>([]);
  const [selectedGithubRepositoryId, setSelectedGithubRepositoryId] = useState<number>();
  const [linkDialog, setLinkDialog] = useState(false);
  const [repositoryForm, setRepositoryForm] = useState(EMPTY_REPOSITORY);
  const [linkForm, setLinkForm] = useState(EMPTY_LINK);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState("");
  const [workItemQuery, setWorkItemQuery] = useState("");
  const [workItems, setWorkItems] = useState<TPpmWorkItemProjection[]>([]);
  const [selectedWorkItem, setSelectedWorkItem] = useState<TPpmWorkItemProjection>();
  const [searching, setSearching] = useState(false);
  const [writeDialog, setWriteDialog] = useState<TGitWriteDialog>();
  const [writeActionForm, setWriteActionForm] = useState(EMPTY_WRITE_ACTION);
  const [writeActionOperationId, setWriteActionOperationId] = useState("");
  const [writeWorkItem, setWriteWorkItem] = useState<TPpmGitWriteWorkItem>();
  const [writeDialogError, setWriteDialogError] = useState<TPpmGitWriteDialogError>();

  // `silent` keeps the page (and an open dialog) mounted while the overview refreshes after a Git write step.
  const load = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!workspace) return;
      if (!options?.silent) setLoading(true);
      try {
        const response = await service.getOverview(workspace.id, projectId);
        setOverview(response);
        setSelectedRepositoryId((current) =>
          response.repositories.some((repository) => repository.id === current)
            ? current
            : (response.repositories.find((repository) => repository.is_default)?.id ??
              response.repositories[0]?.id ??
              "")
        );
        setError(undefined);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Не удалось открыть Git-раздел.");
      } finally {
        setLoading(false);
      }
    },
    [projectId, service, workspace]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const createRepository = async (event: FormEvent) => {
    event.preventDefault();
    if (!workspace) return;
    setSaving(true);
    try {
      await service.createRepository(workspace.id, projectId, repositoryForm);
      setRepositoryDialog(false);
      setRepositoryForm(EMPTY_REPOSITORY);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось добавить репозиторий.");
    } finally {
      setSaving(false);
    }
  };

  const startGithubConnect = async () => {
    if (!workspace) return;
    setSaving(true);
    try {
      const response = await service.startGithubConnect(workspace.id, projectId);
      window.location.assign(response.authorization_url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось начать подключение GitHub.");
      setSaving(false);
    }
  };

  const openGithubRepositoryDialog = async () => {
    if (!workspace) return;
    const installation = getActiveGithubInstallation(overview?.installations ?? []);
    if (!installation) return;
    setSaving(true);
    try {
      const repositories = await service.getGithubRepositories(workspace.id, projectId, installation.id);
      setGithubRepositories(repositories.filter((repository) => !repository.archived));
      setSelectedGithubRepositoryId(repositories.find((repository) => !repository.archived)?.provider_repository_id);
      setGithubDialog(true);
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось получить репозитории GitHub.");
    } finally {
      setSaving(false);
    }
  };

  const connectGithubRepository = async (event: FormEvent) => {
    event.preventDefault();
    if (!workspace || !selectedGithubRepositoryId) return;
    const installation = getActiveGithubInstallation(overview?.installations ?? []);
    if (!installation) return;
    setSaving(true);
    try {
      await service.connectGithubRepository(workspace.id, projectId, installation.id, selectedGithubRepositoryId);
      setGithubDialog(false);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось подключить репозиторий GitHub.");
    } finally {
      setSaving(false);
    }
  };

  const refreshGithubPermissions = async () => {
    if (!workspace) return;
    const installation = getActiveGithubInstallation(overview?.installations ?? []);
    if (!installation) {
      setError("Активная установка GitHub App не найдена.");
      return;
    }
    setSaving(true);
    try {
      await service.refreshGithubInstallation(workspace.id, projectId, installation.id);
      setError(undefined);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось проверить права GitHub App.");
    } finally {
      setSaving(false);
    }
  };

  const syncConnection = async (connection: TPpmGitConnection) => {
    if (!workspace) return;
    setSaving(true);
    try {
      await service.syncConnection(workspace.id, projectId, connection.id);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось запустить синхронизацию.");
    } finally {
      setSaving(false);
    }
  };

  const disconnectConnection = async (connection: TPpmGitConnection) => {
    if (!workspace) return;
    const confirmed = await confirm({
      title: ppmT("code.confirm_disconnect_title").replace("{name}", connection.provider_full_name),
      content: ppmT("code.confirm_disconnect_description"),
      confirmLabel: ppmT("code.confirm_disconnect_action"),
      variant: "danger",
    });
    if (!confirmed) return;
    setSaving(true);
    try {
      await service.disconnectConnection(workspace.id, projectId, connection.id);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось отключить репозиторий.");
    } finally {
      setSaving(false);
    }
  };

  const archiveRepository = async (repository: TPpmGitRepository) => {
    if (!workspace) return;
    const confirmed = await confirm({
      title: ppmT("code.confirm_archive_title").replace("{name}", repository.name),
      content: ppmT("code.confirm_archive_description"),
      confirmLabel: ppmT("code.confirm_archive_action"),
      variant: "danger",
    });
    if (!confirmed) return;
    setSaving(true);
    try {
      await service.archiveRepository(workspace.id, projectId, repository.id);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось убрать репозиторий.");
    } finally {
      setSaving(false);
    }
  };

  const makeDefault = async (repository: TPpmGitRepository) => {
    if (!workspace) return;
    setSaving(true);
    try {
      await service.updateRepository(workspace.id, projectId, repository.id, { is_default: true });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось выбрать основной репозиторий.");
    } finally {
      setSaving(false);
    }
  };

  const setCodeIndexEnabled = async (repository: TPpmGitRepository, enabled: boolean) => {
    if (!workspace) return;
    if (
      !enabled &&
      !(await confirm({
        title: ppmT("code.confirm_disable_index_title"),
        content: ppmT("code.confirm_disable_index_description"),
        confirmLabel: ppmT("code.confirm_disable_index_action"),
        variant: "danger",
      }))
    )
      return;
    setSaving(true);
    try {
      await service.updateCodeIndexPolicy(workspace.id, projectId, repository.id, {
        branch: repository.code_index.branch || repository.default_branch || "main",
        enabled,
      });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось изменить индексацию кода.");
    } finally {
      setSaving(false);
    }
  };

  const syncCodeIndex = async (repository: TPpmGitRepository) => {
    if (!workspace) return;
    setSaving(true);
    try {
      await service.syncCodeIndex(workspace.id, projectId, repository.id);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось обновить индекс кода.");
    } finally {
      setSaving(false);
    }
  };

  const copy = async (value: string, key: string) => {
    if (await copyTextToClipboard(value)) {
      setCopied(key);
      window.setTimeout(() => setCopied((current) => (current === key ? undefined : current)), 1600);
    } else {
      setError("Браузер не разрешил копирование. Выделите текст вручную.");
    }
  };

  const searchWorkItems = async () => {
    if (!workspace) return;
    setSearching(true);
    try {
      const response = await canvasService.searchWorkItems(workspace.id, projectId, workItemQuery);
      setWorkItems(response.results);
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось найти задачи.");
    } finally {
      setSearching(false);
    }
  };

  const openWriteActionDialog = (prefill?: TPpmGitWriteAction) => {
    // G1.3 writes to GitHub only: repositories of our Git server are not offered here.
    const activeRepositories = overview ? getActiveGithubRepositories(overview) : undefined;
    const connectedRepository =
      activeRepositories?.find((repository) => repository.id === prefill?.preview.repository.id) ??
      activeRepositories?.[0];
    if (!connectedRepository) {
      setError("Сначала подключите активный репозиторий GitHub.");
      return;
    }
    setSelectedRepositoryId(connectedRepository.id);
    const prefillWorkItem = prefill?.preview.work_item;
    setWriteWorkItem(
      prefillWorkItem
        ? { id: prefillWorkItem.id, identifier: prefillWorkItem.identifier, title: prefillWorkItem.title }
        : undefined
    );
    setWorkItemQuery("");
    setWorkItems([]);
    setWriteActionForm(
      prefill
        ? {
            base_ref: prefill.preview.branch.base_ref,
            head_ref: prefill.preview.branch.head_ref,
            title: prefill.preview.draft_pull_request.title,
            body: prefill.preview.draft_pull_request.body,
          }
        : { ...EMPTY_WRITE_ACTION, base_ref: connectedRepository.default_branch || "main" }
    );
    setWriteActionOperationId(crypto.randomUUID());
    setWriteDialogError(undefined);
    setWriteDialog({ mode: "branch_form" });
  };

  const openPullRequestForm = (parent: TPpmGitWriteAction, prefill?: TPpmGitWriteAction) => {
    const plan = (prefill ?? parent).preview.draft_pull_request;
    setWriteActionForm({
      base_ref: parent.preview.branch.base_ref,
      head_ref: parent.preview.branch.head_ref,
      title: plan.title || `${parent.preview.work_item.identifier} — ${parent.preview.work_item.title}`,
      body: plan.body,
    });
    setWriteActionOperationId(crypto.randomUUID());
    setWriteDialogError(undefined);
    setWriteDialog({ mode: "pull_request_form", parent });
  };

  const openWriteAction = (action: TPpmGitWriteAction) => {
    setWriteDialogError(undefined);
    setWriteDialog({ mode: "action", action });
  };

  const selectWriteActionWorkItem = (item: TPpmWorkItemProjection) => {
    const identifier = item.identity.identifier ?? "work-item";
    setWriteWorkItem({ id: item.identity.entity_id, identifier, title: item.display.title });
    setWriteActionForm((current) => ({
      ...current,
      head_ref: current.head_ref || `${identifier.toLowerCase()}/draft-pr`,
      title: current.title || `${identifier} — ${item.display.title}`,
    }));
  };

  const showWriteError = (reason: unknown, fallback: string) => {
    const url = reason instanceof PpmGitServiceError ? reason.details?.canonical_url : undefined;
    setWriteDialogError({
      message: reason instanceof Error ? reason.message : fallback,
      url: typeof url === "string" ? safeGithubUrl(url) : undefined,
    });
  };

  const findWriteAction = async (actionId: string) => {
    if (!workspace) return undefined;
    return (
      overview?.write_actions.items.find((item) => item.id === actionId) ??
      (await service.getWriteAction(workspace.id, projectId, actionId))
    );
  };

  const createWriteActionPreview = async (event: FormEvent) => {
    event.preventDefault();
    if (!workspace || !writeDialog || !writeActionOperationId) return;
    let request: TPpmGitWriteActionRequest;
    if (writeDialog.mode === "branch_form") {
      if (!selectedRepositoryId || !writeWorkItem) return;
      request = {
        action_type: "create_branch",
        ...writeActionForm,
        repository_id: selectedRepositoryId,
        work_item_id: writeWorkItem.id,
        client_operation_id: writeActionOperationId,
      };
    } else if (writeDialog.mode === "pull_request_form") {
      request = {
        action_type: "create_draft_pr",
        parent_action_id: writeDialog.parent.id,
        title: writeActionForm.title,
        body: writeActionForm.body,
        client_operation_id: writeActionOperationId,
      };
    } else return;
    setSaving(true);
    try {
      const action = await service.createWriteActionPreview(workspace.id, projectId, request);
      setWriteDialogError(undefined);
      setWriteDialog({ mode: "action", action });
      await load({ silent: true });
    } catch (reason) {
      showWriteError(reason, "Не удалось подготовить предпросмотр.");
    } finally {
      setSaving(false);
    }
  };

  const refreshWriteAction = async (actionId: string) => {
    if (!workspace) return;
    try {
      const action = await service.getWriteAction(workspace.id, projectId, actionId);
      setWriteDialog((current) => (current?.mode === "action" ? { mode: "action", action } : current));
    } catch {
      // The dialog keeps the last known state; the page banner shows network problems on the next load.
    }
    await load({ silent: true });
  };

  const runWriteCommand = async (command: TPpmGitWriteCommand) => {
    if (!workspace || writeDialog?.mode !== "action") return;
    const current = writeDialog.action;
    if (command === "prepare_pull_request") {
      openPullRequestForm(current);
      return;
    }
    setSaving(true);
    try {
      if (command === "prepare_again" || command === "open_follow_up") {
        if (command === "open_follow_up" && current.follow_up?.pull_request_action) {
          const followUp = await findWriteAction(current.follow_up.pull_request_action.id);
          if (followUp) openWriteAction(followUp);
        } else if (current.stage === "pull_request" && current.parent_action_id) {
          const parent = await findWriteAction(current.parent_action_id);
          if (parent) openPullRequestForm(parent, current);
        } else {
          openWriteActionDialog(current);
        }
        return;
      }
      const action =
        command === "approve" || command === "reject"
          ? await service.decideWriteAction(workspace.id, projectId, current.id, command)
          : command === "cancel"
            ? await service.cancelWriteAction(workspace.id, projectId, current.id)
            : await service.applyWriteAction(workspace.id, projectId, current.id);
      setWriteDialogError(undefined);
      setWriteDialog({ mode: "action", action });
      await load({ silent: true });
    } catch (reason) {
      showWriteError(reason, "Не удалось выполнить Git-действие.");
      // A refused or failed step may have changed its status (conflict/failed): show what PPM recorded.
      await refreshWriteAction(current.id);
    } finally {
      setSaving(false);
    }
  };

  const closeWriteActionDialog = () => {
    setWriteDialog(undefined);
    setWriteDialogError(undefined);
    setWriteWorkItem(undefined);
    setWorkItemQuery("");
    setWorkItems([]);
  };

  const createLink = async (event: FormEvent) => {
    event.preventDefault();
    if (!workspace || !selectedRepositoryId || !selectedWorkItem) return;
    setSaving(true);
    try {
      await service.createLink(workspace.id, projectId, {
        ...linkForm,
        repository_id: selectedRepositoryId,
        work_item_id: selectedWorkItem.identity.entity_id,
      });
      setLinkDialog(false);
      setLinkForm(EMPTY_LINK);
      setSelectedWorkItem(undefined);
      setWorkItemQuery("");
      setWorkItems([]);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось связать Git-объект с задачей.");
    } finally {
      setSaving(false);
    }
  };

  const unlink = async (link: TPpmGitLink) => {
    if (!workspace) return;
    setSaving(true);
    try {
      await service.unlink(workspace.id, projectId, link.id);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось убрать Git-связь.");
    } finally {
      setSaving(false);
    }
  };

  if (!workspace || loading) return <GitState text="Открываем код проекта…" />;
  if (!overview) return <GitState text={error ?? "Git-раздел недоступен."} />;

  // G2.1: our Git server next to GitHub. GitHub-only flows see only GitHub connections and the GitHub App installation.
  const gitServer = getPpmGitServer(overview);
  const connectionsByProvider = splitGitConnectionsByProvider(overview);
  const githubInstallation = getActiveGithubInstallation(overview.installations);
  const githubWritableRepositories = getActiveGithubRepositories(overview);
  const canPrepareWrite = overview.capabilities.manage_write_actions && githubWritableRepositories.length > 0;
  const securityNote = getGitSecurityNote({
    github:
      overview.provider.configured ||
      connectionsByProvider.github.length > 0 ||
      overview.installations.some((item) => item.provider === "github"),
    forgejo: gitServer.configured || connectionsByProvider.forgejo.length > 0,
  });

  return (
    <>
      <PageHead title={`${project?.name ?? "PPM"} — Код`} />
      <main className="h-full overflow-y-auto bg-surface-1 px-5 py-6 sm:px-8">
        <div className="mx-auto flex max-w-6xl flex-col gap-6">
          <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-11 font-semibold tracking-[0.16em] text-accent-primary uppercase">Git</p>
              <h1 className="mt-2 text-24 font-semibold text-primary">Код проекта</h1>
              <p className="mt-1 max-w-2xl text-13 leading-6 text-secondary">
                Репозитории, ветки, коммиты и связи с задачами. Файлы кода читаются только после отдельного включения
                безопасного поиска для выбранного репозитория.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {canPrepareWrite && (
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-md border border-accent-strong/40 bg-accent-primary/5 px-3 py-2 text-12 font-semibold text-accent-primary hover:bg-accent-primary/10"
                  onClick={() => openWriteActionDialog()}
                >
                  <GitPullRequest className="size-4" aria-hidden="true" /> Ветка и черновик PR
                </button>
              )}
              {overview.capabilities.manage_links && overview.repositories.length > 0 && (
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-md border border-subtle bg-surface-2 px-3 py-2 text-12 font-semibold text-primary hover:bg-layer-1"
                  onClick={() => setLinkDialog(true)}
                >
                  <Link2 className="size-4" aria-hidden="true" /> Связать с задачей
                </button>
              )}
              {overview.capabilities.manage_repositories && (
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-md bg-accent-primary px-3 py-2 text-12 font-semibold text-on-accent"
                  onClick={() => setRepositoryDialog(true)}
                >
                  <Plus className="size-4" aria-hidden="true" /> Добавить вручную
                </button>
              )}
            </div>
          </header>

          {error && (
            <div
              className="flex items-start justify-between gap-3 rounded-lg border border-danger-subtle bg-danger-subtle p-3 text-12 text-primary"
              role="alert"
            >
              <span>{error}</span>
              <button type="button" aria-label="Закрыть сообщение" onClick={() => setError(undefined)}>
                <X className="size-4" />
              </button>
            </div>
          )}

          <ForgejoProviderPanel
            canConnect={gitServer.canManage}
            canSync={overview.capabilities.manage_provider}
            configured={gitServer.configured}
            connections={connectionsByProvider.forgejo}
            onConnect={() => setGitServerDialog(true)}
            onDisconnect={(connection) => void disconnectConnection(connection)}
            onSync={(connection) => void syncConnection(connection)}
            publicUrl={gitServer.publicUrl}
            repositories={overview.repositories}
            saving={saving}
          />

          <GithubProviderPanel
            canManage={overview.capabilities.manage_provider}
            connections={connectionsByProvider.github}
            configured={overview.provider.configured}
            installations={overview.installations}
            saving={saving}
            onConnect={() => void startGithubConnect()}
            onDisconnect={(connection) => void disconnectConnection(connection)}
            onSelectRepository={() => void openGithubRepositoryDialog()}
            onSync={(connection) => void syncConnection(connection)}
          />

          <div className="flex items-start gap-3 rounded-xl border border-subtle bg-layer-1 p-4">
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-accent-primary" aria-hidden="true" />
            <div>
              <p className="text-13 font-semibold text-primary">Без хранения токенов и SSH-ключей</p>
              <p className="mt-1 text-12 leading-5 text-secondary">{securityNote}</p>
            </div>
          </div>

          <GitWriteActionsPanel
            actions={overview.write_actions.items}
            canRefreshPermissions={overview.capabilities.manage_provider && Boolean(githubInstallation)}
            canPrepare={canPrepareWrite}
            onOpen={openWriteAction}
            onPrepare={() => openWriteActionDialog()}
            onRefreshPermissions={() => void refreshGithubPermissions()}
            readiness={overview.write_actions.readiness}
            refreshingPermissions={saving}
          />

          <section aria-labelledby="ppm-git-repositories-title">
            <div className="mb-3 flex items-center justify-between">
              <h2 id="ppm-git-repositories-title" className="text-16 font-semibold text-primary">
                Репозитории
              </h2>
              <span className="text-11 text-tertiary">{overview.repositories.length}</span>
            </div>
            {overview.repositories.length === 0 ? (
              <div className="rounded-xl border border-dashed border-subtle bg-surface-2 p-8 text-center">
                <Code2 className="mx-auto size-8 text-accent-primary" aria-hidden="true" />
                <h3 className="mt-3 text-16 font-semibold text-primary">Добавьте первый репозиторий</h3>
                <p className="mx-auto mt-2 max-w-lg text-12 leading-5 text-secondary">
                  Укажите безопасные адреса клонирования HTTPS/SSH. PPM не подключается к поставщику Git и не
                  запрашивает пароль.
                </p>
              </div>
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                {overview.repositories.map((repository) => (
                  <RepositoryCard
                    canManage={overview.capabilities.manage_repositories}
                    canManageCode={overview.capabilities.manage_provider}
                    canvasHref={gitCanvasHref(workspaceSlug, projectId, repository)}
                    copied={copied}
                    hasActiveConnection={overview.connections.some(
                      (connection) => connection.repository_id === repository.id && connection.status === "active"
                    )}
                    key={repository.id}
                    onArchive={archiveRepository}
                    onCopy={(value, key) => void copy(value, key)}
                    onMakeDefault={makeDefault}
                    onSyncCode={syncCodeIndex}
                    onToggleCode={setCodeIndexEnabled}
                    repository={repository}
                    saving={saving}
                  />
                ))}
              </div>
            )}
          </section>

          {overview.objects.length > 0 && (
            <section aria-labelledby="ppm-git-objects-title">
              <div className="mb-3 flex items-center justify-between">
                <h2 id="ppm-git-objects-title" className="text-16 font-semibold text-primary">
                  Ветки, коммиты и запросы на слияние
                </h2>
                <span className="text-11 text-tertiary">{overview.objects.length}</span>
              </div>
              <div className="overflow-hidden rounded-xl border border-subtle bg-surface-2">
                {overview.objects.map((gitObject) => (
                  <GitObjectRow
                    gitObject={gitObject}
                    key={gitObject.id}
                    projectId={projectId}
                    repository={overview.repositories.find((item) => item.id === gitObject.repository_id)}
                    workspaceSlug={workspaceSlug}
                  />
                ))}
              </div>
            </section>
          )}

          <section aria-labelledby="ppm-git-links-title">
            <div className="mb-3 flex items-center justify-between">
              <h2 id="ppm-git-links-title" className="text-16 font-semibold text-primary">
                Связи с задачами
              </h2>
              <span className="text-11 text-tertiary">{overview.links.length}</span>
            </div>
            {overview.links.length === 0 ? (
              <div className="rounded-xl border border-subtle bg-surface-2 p-6 text-13 text-secondary">
                Здесь появятся ветки, коммиты и запросы на слияние, связанные с задачами этого проекта.
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-subtle bg-surface-2">
                {overview.links.map((link) => (
                  <GitLinkRow
                    canUnlink={overview.capabilities.manage_links}
                    key={link.id}
                    link={link}
                    onUnlink={unlink}
                    projectId={projectId}
                    workspaceSlug={workspaceSlug}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-subtle bg-surface-2 p-5" aria-labelledby="ppm-git-guide-title">
            <h2 id="ppm-git-guide-title" className="text-16 font-semibold text-primary">
              Соглашение команды
            </h2>
            <p className="mt-1 text-12 text-secondary">Ключ задачи связывает работу в PPM с обычным Git-процессом.</p>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              {Object.entries(overview.conventions).map(([kind, example]) => (
                <div className="rounded-lg border border-subtle bg-layer-1 p-3" key={kind}>
                  <span className="text-11 font-semibold text-tertiary">
                    {kind === "pull_request" ? "Запрос на слияние (PR)" : kind === "branch" ? "Ветка" : "Коммит"}
                  </span>
                  <code className="mt-2 block text-12 break-all text-primary">{example}</code>
                </div>
              ))}
            </div>
          </section>
        </div>
      </main>

      {repositoryDialog && (
        <RepositoryDialog
          form={repositoryForm}
          saving={saving}
          onChange={setRepositoryForm}
          onClose={() => setRepositoryDialog(false)}
          onSubmit={createRepository}
        />
      )}
      {githubDialog && (
        <GithubRepositoryDialog
          repositories={githubRepositories}
          repositoryId={selectedGithubRepositoryId}
          saving={saving}
          onClose={() => setGithubDialog(false)}
          onRepositoryChange={setSelectedGithubRepositoryId}
          onSubmit={connectGithubRepository}
        />
      )}
      {gitServerDialog && (
        <GitServerRepositoryDialog
          connect={(providerRepositoryId) =>
            service.connectForgejoRepository(workspace.id, projectId, providerRepositoryId)
          }
          list={(request) => service.listForgejoRepositories(workspace.id, projectId, request)}
          onClose={() => setGitServerDialog(false)}
          onConnected={async () => {
            await load({ silent: true });
            setGitServerDialog(false);
          }}
          publicUrl={gitServer.publicUrl}
        />
      )}
      {linkDialog && (
        <LinkDialog
          form={linkForm}
          repositories={overview.repositories}
          repositoryId={selectedRepositoryId}
          saving={saving}
          searching={searching}
          selectedWorkItem={selectedWorkItem}
          workItemQuery={workItemQuery}
          workItems={workItems}
          onChange={setLinkForm}
          onClose={() => setLinkDialog(false)}
          onQueryChange={setWorkItemQuery}
          onRepositoryChange={setSelectedRepositoryId}
          onSearch={() => void searchWorkItems()}
          onSelectWorkItem={setSelectedWorkItem}
          onSubmit={createLink}
        />
      )}
      {writeDialog && (
        <DialogFrame
          onClose={closeWriteActionDialog}
          saving={saving}
          title={
            writeDialog.mode === "branch_form"
              ? "Шаг 1 · новая ветка"
              : writeDialog.mode === "pull_request_form"
                ? "Шаг 2 · черновик PR"
                : writeDialog.action.stage === "pull_request"
                  ? "Черновик PR: предпросмотр и решение"
                  : "Ветка: предпросмотр и решение"
          }
        >
          {writeDialog.mode === "branch_form" && (
            <GitWriteBranchForm
              error={writeDialogError}
              form={writeActionForm}
              repositories={githubWritableRepositories}
              repositoryId={selectedRepositoryId}
              saving={saving}
              searching={searching}
              workItem={writeWorkItem}
              workItemQuery={workItemQuery}
              workItems={workItems}
              onChange={setWriteActionForm}
              onClose={closeWriteActionDialog}
              onQueryChange={setWorkItemQuery}
              onRepositoryChange={(repositoryId) => {
                const repository = overview.repositories.find((item) => item.id === repositoryId);
                setSelectedRepositoryId(repositoryId);
                setWriteActionForm((current) => ({
                  ...current,
                  base_ref: repository?.default_branch || "main",
                }));
              }}
              onSearch={() => void searchWorkItems()}
              onSelectWorkItem={selectWriteActionWorkItem}
              onSubmit={createWriteActionPreview}
            />
          )}
          {writeDialog.mode === "pull_request_form" && (
            <GitWritePullRequestForm
              error={writeDialogError}
              form={writeActionForm}
              parent={writeDialog.parent}
              saving={saving}
              onChange={setWriteActionForm}
              onClose={closeWriteActionDialog}
              onSubmit={createWriteActionPreview}
            />
          )}
          {writeDialog.mode === "action" && (
            <GitWriteActionDetails
              action={writeDialog.action}
              canManage={overview.capabilities.manage_write_actions}
              copied={copied}
              error={writeDialogError}
              saving={saving}
              onCommand={(command) => void runWriteCommand(command)}
              onCopy={(value, key) => void copy(value, key)}
              onRefresh={() => void refreshWriteAction(writeDialog.action.id)}
            />
          )}
        </DialogFrame>
      )}
      {confirmDialog}
    </>
  );
}

// G2.1 (R10): the repository picker of our Git server in the page's dialog frame. While a repository is being connected
// the dialog cannot be closed (Esc, backdrop, × and «Закрыть»): the result — a refreshed page or the reason of a
// refusal — always lands in this dialog, and a late answer can never close a dialog opened again.
function GitServerRepositoryDialog({
  connect,
  list,
  onClose,
  onConnected,
  publicUrl,
}: TForgejoPickerDeps & { onClose: () => void; publicUrl: string | null }) {
  const { picker, state } = useForgejoRepositoryPicker({ connect, list, onConnected });
  const connecting = state.connectingId !== undefined;
  return (
    <DialogFrame
      closeDisabled={connecting}
      onClose={onClose}
      saving={connecting}
      title="Подключить репозиторий с нашего Git-сервера"
    >
      <ForgejoRepositoryPicker
        onClose={onClose}
        onConnect={(providerRepositoryId) => void picker.connect(providerRepositoryId)}
        onLoadMore={picker.loadMore}
        onQueryChange={picker.setQuery}
        onReload={picker.reload}
        publicUrl={publicUrl}
        state={state}
      />
    </DialogFrame>
  );
}

function GithubProviderPanel({
  canManage,
  configured,
  connections,
  installations,
  onConnect,
  onDisconnect,
  onSelectRepository,
  onSync,
  saving,
}: {
  canManage: boolean;
  configured: boolean;
  connections: TPpmGitConnection[];
  installations: TPpmGitOverview["installations"];
  onConnect: () => void;
  onDisconnect: (connection: TPpmGitConnection) => void;
  onSelectRepository: () => void;
  onSync: (connection: TPpmGitConnection) => void;
  saving: boolean;
}) {
  const installation = getActiveGithubInstallation(installations);
  return (
    <section className="rounded-xl border border-subtle bg-surface-2 p-5" aria-labelledby="ppm-github-title">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-layer-1 text-primary">
            <Github className="size-5" aria-hidden="true" />
          </div>
          <div>
            <h2 id="ppm-github-title" className="text-16 font-semibold text-primary">
              GitHub App
            </h2>
            <p className="mt-1 max-w-2xl text-12 leading-5 text-secondary">
              Безопасная синхронизация веток, коммитов и запросов на слияние. Доступ только на чтение и только к
              выбранным репозиториям этого проекта.
            </p>
            {installation && (
              <p className="mt-2 text-12 text-tertiary">
                Учётная запись: <span className="font-semibold text-secondary">{installation.account_login}</span>
              </p>
            )}
          </div>
        </div>
        {canManage && (
          <div className="flex shrink-0 flex-wrap gap-2">
            {!configured ? (
              <span className="rounded-md border border-subtle px-3 py-2 text-12 text-tertiary">
                Требуется настройка администратором PPM
              </span>
            ) : installation ? (
              <button
                type="button"
                className="rounded-md bg-accent-primary px-3 py-2 text-12 font-semibold text-on-accent disabled:opacity-50"
                disabled={saving}
                onClick={onSelectRepository}
              >
                Выбрать репозиторий
              </button>
            ) : (
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-md bg-accent-primary px-3 py-2 text-12 font-semibold text-on-accent disabled:opacity-50"
                disabled={saving}
                onClick={onConnect}
              >
                <Github className="size-4" aria-hidden="true" /> Подключить GitHub
              </button>
            )}
          </div>
        )}
      </div>

      {connections.length > 0 && (
        <div className="mt-4 grid gap-2 border-t border-subtle pt-4">
          {connections.map((connection) => (
            <GitConnectionRow
              canDisconnect={canManage}
              canSync={canManage}
              connection={connection}
              key={connection.id}
              onDisconnect={onDisconnect}
              onSync={onSync}
              provider="github"
              saving={saving}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function GithubRepositoryDialog({
  onClose,
  onRepositoryChange,
  onSubmit,
  repositories,
  repositoryId,
  saving,
}: {
  onClose: () => void;
  onRepositoryChange: (repositoryId: number) => void;
  onSubmit: (event: FormEvent) => void;
  repositories: TPpmGitHubRepository[];
  repositoryId?: number;
  saving: boolean;
}) {
  return (
    <DialogFrame onClose={onClose} saving={saving} title="Подключить репозиторий GitHub">
      {repositories.length === 0 ? (
        <div className="rounded-lg border border-dashed border-subtle p-6 text-center text-12 text-secondary">
          GitHub App не видит доступных репозиториев. Добавьте репозиторий в настройках установки GitHub App.
        </div>
      ) : (
        <form className="grid gap-4" onSubmit={onSubmit}>
          <label className="text-12 font-semibold text-secondary">
            Репозиторий
            <select
              className="mt-2 w-full rounded-md border border-subtle bg-surface-2 px-3 py-2 text-13 text-primary"
              value={repositoryId ?? ""}
              onChange={(event) => onRepositoryChange(Number(event.target.value))}
            >
              {repositories.map((repository) => (
                <option key={repository.provider_repository_id} value={repository.provider_repository_id}>
                  {repository.full_name} · {PPM_GIT_VISIBILITY_LABELS[repository.visibility]}
                </option>
              ))}
            </select>
          </label>
          <p className="text-12 leading-5 text-tertiary">
            PPM запросит только чтение метаданных. Пароли, SSH-ключи и токены в базе не сохраняются.
          </p>
          <DialogActions disabled={!repositoryId} onClose={onClose} saving={saving} submitLabel="Подключить" />
        </form>
      )}
    </DialogFrame>
  );
}

function GitObjectRow({
  gitObject,
  projectId,
  repository,
  workspaceSlug,
}: {
  gitObject: TPpmGitObject;
  projectId: string;
  repository?: TPpmGitRepository;
  workspaceSlug: string;
}) {
  const Icon = OBJECT_ICONS[gitObject.object_type];
  // G2.1 D-3: a PR row also names its status («Открыт»/«Черновик»/«Закрыт»/«Слит»); branches and commits have no such
  // status. No merge timestamp: the API does not send one on this list (git-provider-labels.ts, getGitPullRequestStatusLabel).
  const statusLabel =
    gitObject.object_type === "pull_request" ? getGitPullRequestStatusLabel(gitObject.state, gitObject.is_draft) : null;
  return (
    <article className="flex items-center gap-3 border-b border-subtle p-4 last:border-b-0">
      <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-layer-1 text-accent-primary">
        <Icon className="size-4" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-13 font-semibold text-primary">{gitObject.title}</p>
        <p className="mt-0.5 truncate text-12 text-secondary">
          {OBJECT_LABELS[gitObject.object_type]}
          {gitObject.ref ? ` · ${gitObject.ref}` : ""}
          {repository ? ` · ${repository.name}` : ""}
          {statusLabel ? ` · ${statusLabel}` : ""}
        </p>
      </div>
      <a
        className="grid size-8 place-items-center rounded-md text-secondary hover:bg-layer-1 hover:text-primary"
        href={gitObject.canonical_url}
        target="_blank"
        rel="noreferrer"
        aria-label="Открыть Git-объект"
      >
        <ExternalLink className="size-4" />
      </a>
      {repository && (
        <Link
          className="grid size-8 place-items-center rounded-md text-secondary hover:bg-layer-1 hover:text-primary"
          href={gitCanvasHref(workspaceSlug, projectId, gitObject, repository)}
          aria-label="Добавить Git-объект на холст"
        >
          <Code2 className="size-4" />
        </Link>
      )}
    </article>
  );
}

function GitLinkRow({
  canUnlink,
  link,
  onUnlink,
  projectId,
  workspaceSlug,
}: {
  canUnlink: boolean;
  link: TPpmGitLink;
  onUnlink: (link: TPpmGitLink) => void;
  projectId: string;
  workspaceSlug: string;
}) {
  const Icon = OBJECT_ICONS[link.object_type];
  // G2.1 D-3: same PR status as GitObjectRow; a link only carries git_object_state (no is_draft), so a draft PR
  // reads as «Открыт» here — still correct, just less specific than the objects list.
  const statusLabel = link.object_type === "pull_request" ? getGitPullRequestStatusLabel(link.git_object_state) : null;
  return (
    <article className="flex flex-col gap-3 border-b border-subtle p-4 last:border-b-0 sm:flex-row sm:items-center">
      <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-layer-1 text-accent-primary">
        <Icon className="size-4" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-11 font-semibold text-accent-primary">{link.work_item.identifier}</span>
          <span className="text-11 text-tertiary">
            {OBJECT_LABELS[link.object_type]} · {link.repository_name}
            {statusLabel ? ` · ${statusLabel}` : ""}
          </span>
        </div>
        <p className="mt-1 truncate text-13 font-semibold text-primary">{link.title}</p>
        <p className="mt-0.5 truncate text-12 text-secondary">{link.work_item.title}</p>
      </div>
      <div className="flex items-center gap-1">
        <a
          className="grid size-8 place-items-center rounded-md text-secondary hover:bg-layer-1 hover:text-primary"
          href={link.canonical_url}
          target="_blank"
          rel="noreferrer"
          aria-label="Открыть Git-объект"
        >
          <ExternalLink className="size-4" />
        </a>
        <Link
          className="grid size-8 place-items-center rounded-md text-secondary hover:bg-layer-1 hover:text-primary"
          href={gitCanvasHref(workspaceSlug, projectId, link)}
          aria-label="Добавить Git-объект на холст"
        >
          <Code2 className="size-4" />
        </Link>
        {canUnlink && (
          <button
            type="button"
            className="grid size-8 place-items-center rounded-md text-secondary hover:bg-danger-subtle hover:text-danger-primary"
            aria-label="Убрать связь"
            onClick={() => onUnlink(link)}
          >
            <Unlink className="size-4" />
          </button>
        )}
      </div>
    </article>
  );
}

function RepositoryDialog({
  form,
  onChange,
  onClose,
  onSubmit,
  saving,
}: {
  form: TPpmGitRepositoryRequest;
  onChange: (form: TPpmGitRepositoryRequest) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
  saving: boolean;
}) {
  return (
    <DialogFrame onClose={onClose} saving={saving} title="Добавить репозиторий">
      <form className="grid gap-4" onSubmit={onSubmit}>
        <FormInput
          label="Название"
          required
          value={form.name}
          onChange={(value) => onChange({ ...form, name: value })}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-12 font-semibold text-secondary">
            Поставщик Git
            <select
              className="mt-2 w-full rounded-md border border-subtle bg-surface-2 px-3 py-2 text-13 text-primary"
              value={form.provider}
              onChange={(event) => onChange({ ...form, provider: event.target.value as TPpmGitProvider })}
            >
              {PPM_GIT_MANUAL_PROVIDERS.map((value) => (
                <option key={value} value={value}>
                  {PPM_GIT_PROVIDER_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-12 font-semibold text-secondary">
            Видимость
            <select
              className="mt-2 w-full rounded-md border border-subtle bg-surface-2 px-3 py-2 text-13 text-primary"
              value={form.visibility}
              onChange={(event) =>
                onChange({ ...form, visibility: event.target.value as TPpmGitRepositoryRequest["visibility"] })
              }
            >
              <option value="unknown">Не указана</option>
              <option value="public">Публичный</option>
              <option value="private">Приватный</option>
              <option value="internal">Внутренний</option>
            </select>
          </label>
        </div>
        <FormInput
          label="Основная ветка"
          value={form.default_branch}
          onChange={(value) => onChange({ ...form, default_branch: value })}
        />
        <FormInput
          label="Страница репозитория (HTTPS)"
          placeholder="https://github.com/org/repo"
          required
          value={form.canonical_url}
          onChange={(value) => onChange({ ...form, canonical_url: value })}
        />
        <FormInput
          label="Адрес клонирования HTTPS"
          placeholder="https://github.com/org/repo.git"
          required
          value={form.clone_https}
          onChange={(value) => onChange({ ...form, clone_https: value })}
        />
        <FormInput
          label="Адрес клонирования SSH — необязательно"
          placeholder="git@github.com:org/repo.git"
          value={form.clone_ssh}
          onChange={(value) => onChange({ ...form, clone_ssh: value })}
        />
        <label className="flex items-center gap-2 text-12 text-secondary">
          <input
            type="checkbox"
            checked={form.is_default}
            onChange={(event) => onChange({ ...form, is_default: event.target.checked })}
          />
          Сделать основным репозиторием проекта
        </label>
        <DialogActions onClose={onClose} saving={saving} submitLabel="Добавить" />
      </form>
    </DialogFrame>
  );
}

function LinkDialog({
  form,
  onChange,
  onClose,
  onQueryChange,
  onRepositoryChange,
  onSearch,
  onSelectWorkItem,
  onSubmit,
  repositories,
  repositoryId,
  saving,
  searching,
  selectedWorkItem,
  workItemQuery,
  workItems,
}: {
  form: typeof EMPTY_LINK;
  onChange: (form: typeof EMPTY_LINK) => void;
  onClose: () => void;
  onQueryChange: (value: string) => void;
  onRepositoryChange: (value: string) => void;
  onSearch: () => void;
  onSelectWorkItem: (item: TPpmWorkItemProjection) => void;
  onSubmit: (event: FormEvent) => void;
  repositories: TPpmGitRepository[];
  repositoryId: string;
  saving: boolean;
  searching: boolean;
  selectedWorkItem?: TPpmWorkItemProjection;
  workItemQuery: string;
  workItems: TPpmWorkItemProjection[];
}) {
  return (
    <DialogFrame onClose={onClose} saving={saving} title="Связать Git с задачей">
      <form className="grid gap-4" onSubmit={onSubmit}>
        <label className="text-12 font-semibold text-secondary">
          Репозиторий
          <select
            className="mt-2 w-full rounded-md border border-subtle bg-surface-2 px-3 py-2 text-13 text-primary"
            value={repositoryId}
            onChange={(event) => onRepositoryChange(event.target.value)}
          >
            {repositories.map((repository) => (
              <option key={repository.id} value={repository.id}>
                {repository.name}
              </option>
            ))}
          </select>
        </label>
        <div>
          <label className="text-12 font-semibold text-secondary" htmlFor="ppm-git-work-item-search">
            Задача проекта
          </label>
          <div className="mt-2 flex gap-2">
            <input
              id="ppm-git-work-item-search"
              className="min-w-0 flex-1 rounded-md border border-subtle bg-surface-2 px-3 py-2 text-13 text-primary"
              placeholder="Ключ или название"
              value={workItemQuery}
              onChange={(event) => onQueryChange(event.target.value)}
            />
            <button
              type="button"
              className="grid size-9 place-items-center rounded-md border border-subtle text-secondary hover:text-primary"
              aria-label="Найти задачу"
              onClick={onSearch}
            >
              {searching ? <LoaderCircle className="size-4 animate-spin" /> : <Search className="size-4" />}
            </button>
          </div>
          {selectedWorkItem && (
            <div className="mt-2 rounded-md border border-accent-strong/40 bg-accent-primary/5 p-2 text-12 text-primary">
              <strong>{selectedWorkItem.identity.identifier}</strong> · {selectedWorkItem.display.title}
            </div>
          )}
          {workItems.length > 0 && !selectedWorkItem && (
            <div className="mt-2 max-h-36 overflow-y-auto rounded-md border border-subtle bg-surface-2 p-1">
              {workItems.map((item) => (
                <button
                  type="button"
                  className="block w-full rounded px-2 py-2 text-left text-12 text-secondary hover:bg-layer-1 hover:text-primary"
                  key={item.identity.entity_id}
                  onClick={() => onSelectWorkItem(item)}
                >
                  <strong className="text-primary">{item.identity.identifier}</strong> · {item.display.title}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-12 font-semibold text-secondary">
            Тип
            <select
              className="mt-2 w-full rounded-md border border-subtle bg-surface-2 px-3 py-2 text-13 text-primary"
              value={form.object_type}
              onChange={(event) => onChange({ ...form, object_type: event.target.value as TPpmGitObjectType })}
            >
              {Object.entries(OBJECT_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <FormInput
            label="Ветка, хеш или номер"
            placeholder="feature/GIT-1 или 42"
            value={form.ref}
            onChange={(value) => onChange({ ...form, ref: value })}
          />
        </div>
        <FormInput
          label="Название"
          placeholder="GIT-1 — Настроить интеграцию"
          required
          value={form.title}
          onChange={(value) => onChange({ ...form, title: value })}
        />
        <FormInput
          label="Каноническая HTTPS-ссылка"
          placeholder="https://github.com/org/repo/pull/42"
          required
          value={form.canonical_url}
          onChange={(value) => onChange({ ...form, canonical_url: value })}
        />
        <DialogActions
          disabled={!selectedWorkItem || !repositoryId}
          onClose={onClose}
          saving={saving}
          submitLabel="Связать"
        />
      </form>
    </DialogFrame>
  );
}

// Plane ModalCore: focus trap and focus return. Esc closes (not during a request); a backdrop click does not,
// so typed input survives a stray click — focus goes back to the field the user was in.
function DialogFrame({
  children,
  closeDisabled = false,
  onClose,
  saving = false,
  title,
}: {
  children: ReactNode;
  /** G2.1: the × is inactive too (the Git-server dialog while it connects a repository). */
  closeDisabled?: boolean;
  onClose: () => void;
  saving?: boolean;
  title: string;
}) {
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  return (
    <ModalCore
      isOpen
      handleClose={() => {
        if (shouldDismissPpmDialog({ reason: "backdrop", saving })) onClose();
        else lastFocusedRef.current?.focus();
      }}
      width={EModalWidth.XL}
    >
      <section
        className="max-h-[90vh] overflow-y-auto p-5"
        role="presentation"
        onFocus={(event) => {
          lastFocusedRef.current = event.target;
        }}
        onKeyDown={(event) => handlePpmDialogKeyDown(event, { saving, onClose })}
      >
        <div className="mb-5 flex items-center justify-between gap-3">
          <Dialog.Title as="h2" className="text-16 font-semibold text-primary">
            {title}
          </Dialog.Title>
          <button
            type="button"
            className="disabled:opacity-50"
            aria-label="Закрыть"
            disabled={closeDisabled}
            onClick={onClose}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        {children}
      </section>
    </ModalCore>
  );
}

function GitState({ text }: { text: string }) {
  return (
    <div className="grid h-full min-h-72 place-items-center bg-surface-1 p-8 text-center">
      <div>
        <LoaderCircle className="mx-auto size-6 animate-spin text-accent-primary" aria-hidden="true" />
        <p className="mt-3 text-13 text-secondary">{text}</p>
      </div>
    </div>
  );
}

function gitCanvasHref(
  workspaceSlug: string,
  projectId: string,
  source: TPpmGitRepository | TPpmGitLink | TPpmGitObject,
  objectRepository?: TPpmGitRepository
) {
  const isRepository = "clone_https" in source;
  const isObject = "connection_id" in source;
  const provider = isRepository
    ? source.provider
    : isObject
      ? (objectRepository?.provider ?? "generic")
      : source.repository_provider;
  const repositoryName = isRepository
    ? source.name
    : isObject
      ? objectRepository?.provider_full_name || objectRepository?.name || "Git"
      : source.repository_name;
  const title = isRepository ? source.name : source.title;
  const objectType = isRepository ? "repository" : source.object_type;
  const sourceId = isRepository ? source.id : isObject ? source.id : (source.git_object_id ?? source.id);
  const parameters = new URLSearchParams({
    ppm_git_id: sourceId,
    ppm_git_provider: provider,
    ppm_git_repository: repositoryName,
    ppm_git_title: title,
    ppm_git_type: objectType,
    ppm_git_url: source.canonical_url,
  });
  if (!isRepository && !isObject) parameters.set("ppm_git_work_item", source.work_item.identifier);
  return `/${workspaceSlug}/projects/${projectId}/brain?${parameters.toString()}`;
}
