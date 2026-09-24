import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Dialog } from "@headlessui/react";
import {
  Archive,
  Check,
  Clipboard,
  Code2,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Github,
  Link2,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Star,
  Unlink,
  X,
} from "lucide-react";
import Link from "next/link";
import { EModalWidth, ModalCore } from "@plane/ui";
import type { TPpmWorkItemProjection } from "@ppm/canvas";
import { PageHead } from "@/components/core/page-title";
import { usePpmConfirm } from "@/components/ppm-shell/use-ppm-confirm";
import { handlePpmDialogKeyDown, shouldDismissPpmDialog } from "@/helpers/ppm-dialog-dismiss.helper";
import { getPpmGitWebhookStatus, type TPpmGitWebhookStatus } from "@/helpers/ppm-git-webhook-status.helper";
import { useProject } from "@/hooks/store/use-project";
import { useWorkspace } from "@/hooks/store/use-workspace";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { PpmCanvasService } from "@/services/ppm-canvas.service";
import {
  PpmGitService,
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
  type TPpmGitWriteReadiness,
} from "@/services/ppm-git.service";

type TPpmGitRouteProps = {
  projectId: string;
  workspaceSlug: string;
};

const PROVIDER_LABELS: Record<TPpmGitProvider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  gitea: "Gitea",
  generic: "Git",
};

const VISIBILITY_LABELS: Record<TPpmGitRepository["visibility"], string> = {
  public: "публичный",
  private: "приватный",
  internal: "внутренний",
  unknown: "видимость не указана",
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

const CODE_INDEX_STATUS_LABELS = {
  failed: "Ошибка индексации",
  pending: "Индексация ожидает запуска",
  ready: "Код доступен Мозгу проекта",
  revoked: "Индекс удалён",
  superseded: "Снимок заменён",
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

const EMPTY_WRITE_ACTION: Pick<TPpmGitWriteActionRequest, "base_ref" | "head_ref" | "title" | "body"> = {
  base_ref: "main",
  head_ref: "",
  title: "",
  body: "",
};

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
  const [writeActionDialog, setWriteActionDialog] = useState(false);
  const [writeActionForm, setWriteActionForm] = useState(EMPTY_WRITE_ACTION);
  const [writeActionOperationId, setWriteActionOperationId] = useState("");
  const [writeActionPreview, setWriteActionPreview] = useState<TPpmGitWriteAction>();

  const load = useCallback(async () => {
    if (!workspace) return;
    setLoading(true);
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
  }, [projectId, service, workspace]);

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
    const installation = overview?.installations.find((item) => item.status === "active");
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
    const installation = overview?.installations.find((item) => item.status === "active");
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
    const installation = overview?.installations.find((item) => item.status === "active");
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
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied((current) => (current === key ? undefined : current)), 1600);
    } catch {
      setError("Браузер не разрешил копирование. Выделите адрес вручную.");
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

  const openWriteActionDialog = () => {
    const connectedRepository = overview?.repositories.find((repository) =>
      overview.connections.some(
        (connection) => connection.repository_id === repository.id && connection.status === "active"
      )
    );
    if (!connectedRepository) {
      setError("Сначала подключите активный репозиторий GitHub.");
      return;
    }
    setSelectedRepositoryId(connectedRepository.id);
    setSelectedWorkItem(undefined);
    setWorkItemQuery("");
    setWorkItems([]);
    setWriteActionForm({
      ...EMPTY_WRITE_ACTION,
      base_ref: connectedRepository.default_branch || "main",
    });
    setWriteActionOperationId(crypto.randomUUID());
    setWriteActionPreview(undefined);
    setWriteActionDialog(true);
  };

  const selectWriteActionWorkItem = (item: TPpmWorkItemProjection) => {
    const identifier = item.identity.identifier ?? "work-item";
    setSelectedWorkItem(item);
    setWriteActionForm((current) => ({
      ...current,
      head_ref: current.head_ref || `${identifier.toLowerCase()}/draft-pr`,
      title: current.title || `${identifier} — ${item.display.title}`,
    }));
  };

  const createWriteActionPreview = async (event: FormEvent) => {
    event.preventDefault();
    if (!workspace || !selectedRepositoryId || !selectedWorkItem || !writeActionOperationId) return;
    setSaving(true);
    try {
      const action = await service.createWriteActionPreview(workspace.id, projectId, {
        ...writeActionForm,
        repository_id: selectedRepositoryId,
        work_item_id: selectedWorkItem.identity.entity_id,
        client_operation_id: writeActionOperationId,
      });
      setWriteActionPreview(action);
      setError(undefined);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось подготовить Git preview.");
    } finally {
      setSaving(false);
    }
  };

  const decideWriteAction = async (decision: "approve" | "reject") => {
    if (!workspace || !writeActionPreview) return;
    setSaving(true);
    try {
      const action = await service.decideWriteAction(workspace.id, projectId, writeActionPreview.id, decision);
      setWriteActionPreview(action);
      setError(undefined);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось сохранить решение по Git-действию.");
      await load();
    } finally {
      setSaving(false);
    }
  };

  const closeWriteActionDialog = () => {
    setWriteActionDialog(false);
    setWriteActionPreview(undefined);
    setSelectedWorkItem(undefined);
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
              {overview.capabilities.manage_write_actions &&
                overview.connections.some((connection) => connection.status === "active") && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-2 rounded-md border border-accent-strong/40 bg-accent-primary/5 px-3 py-2 text-12 font-semibold text-accent-primary hover:bg-accent-primary/10"
                    onClick={openWriteActionDialog}
                  >
                    <GitPullRequest className="size-4" aria-hidden="true" /> Подготовить ветку и draft PR
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

          <GithubProviderPanel
            canManage={overview.capabilities.manage_provider}
            connections={overview.connections}
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
              <p className="mt-1 text-12 leading-5 text-secondary">
                PPM получает краткоживущий доступ только на чтение и не сохраняет токены. При включённом поиске
                индексируются только разрешённые текстовые файлы точного коммита; секреты, зависимости и двоичные файлы
                отбрасываются. Коммиты и отправка изменений по-прежнему выполняются обычным Git.
              </p>
            </div>
          </div>

          <GitWriteActionsPanel
            actions={overview.write_actions.items}
            applyAvailable={overview.write_actions.apply_available}
            canRefreshPermissions={
              overview.capabilities.manage_provider && overview.installations.some((item) => item.status === "active")
            }
            canPrepare={overview.capabilities.manage_write_actions}
            onPrepare={openWriteActionDialog}
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
                    copied={copied}
                    hasActiveConnection={overview.connections.some(
                      (connection) => connection.repository_id === repository.id && connection.status === "active"
                    )}
                    key={repository.id}
                    onArchive={archiveRepository}
                    onCopy={copy}
                    onMakeDefault={makeDefault}
                    onSyncCode={syncCodeIndex}
                    onToggleCode={setCodeIndexEnabled}
                    projectId={projectId}
                    repository={repository}
                    saving={saving}
                    workspaceSlug={workspaceSlug}
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
      {writeActionDialog && (
        <GitWriteActionDialog
          action={writeActionPreview}
          form={writeActionForm}
          repositories={overview.repositories.filter((repository) =>
            overview.connections.some(
              (connection) => connection.repository_id === repository.id && connection.status === "active"
            )
          )}
          repositoryId={selectedRepositoryId}
          saving={saving}
          searching={searching}
          selectedWorkItem={selectedWorkItem}
          workItemQuery={workItemQuery}
          workItems={workItems}
          onChange={setWriteActionForm}
          onClose={closeWriteActionDialog}
          onDecision={(decision) => void decideWriteAction(decision)}
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
      {confirmDialog}
    </>
  );
}

const CONNECTION_STATUS_LABELS: Record<TPpmGitConnection["status"], string> = {
  active: "Подключён",
  syncing: "Синхронизация",
  rate_limited: "GitHub просит подождать",
  permission_drift: "Доступ к репозиторию отозван",
  error: "Ошибка синхронизации",
  suspended: "Установка приостановлена",
  disconnected: "Отключён",
  revoked: "Доступ отозван",
};

const WEBHOOK_STATUS_CLASS_NAMES: Record<TPpmGitWebhookStatus["tone"], string> = {
  confirmed: "border-success-subtle bg-success-subtle text-success-primary",
  waiting: "border-warning-subtle bg-warning-subtle text-warning-primary",
  inactive: "border-subtle bg-surface-2 text-tertiary",
};

const WRITE_ACTION_STATUS_LABELS: Record<TPpmGitWriteAction["status"], string> = {
  proposed: "Ожидает решения",
  approved: "Подтверждено",
  rejected: "Отклонено",
  applying: "Применяется",
  applied: "Создано в GitHub",
  conflict: "Нужно подготовить заново",
  failed: "Ошибка",
  cancelled: "Отменено",
};

function GitWriteActionsPanel({
  actions,
  applyAvailable,
  canRefreshPermissions,
  canPrepare,
  onPrepare,
  onRefreshPermissions,
  readiness,
  refreshingPermissions,
}: {
  actions: TPpmGitWriteAction[];
  applyAvailable: boolean;
  canRefreshPermissions: boolean;
  canPrepare: boolean;
  onPrepare: () => void;
  onRefreshPermissions: () => void;
  readiness: TPpmGitWriteReadiness;
  refreshingPermissions: boolean;
}) {
  return (
    <section className="rounded-xl border border-subtle bg-surface-2 p-5" aria-labelledby="ppm-git-write-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 id="ppm-git-write-title" className="text-16 font-semibold text-primary">
            Ветка и draft PR с подтверждением
          </h2>
          <p className="mt-1 max-w-2xl text-12 leading-5 text-secondary">
            PPM показывает предпросмотр ветки и черновика PR и сохраняет ваше решение. Репозиторий в GitHub при этом не
            меняется.
          </p>
        </div>
        {canPrepare && (
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-2 rounded-md border border-subtle px-3 py-2 text-12 font-semibold text-primary hover:bg-layer-1"
            onClick={onPrepare}
          >
            <GitBranch className="size-4" aria-hidden="true" /> Подготовить preview
          </button>
        )}
      </div>
      {!applyAvailable && (
        <p className="mt-3 rounded-lg border border-warning-subtle bg-warning-subtle p-3 text-12 leading-5 text-secondary">
          Запись в GitHub выключена. Можно проверить предпросмотр и принять или отклонить предложение — репозиторий не
          изменится.
        </p>
      )}
      <GitWriteReadiness
        canRefresh={canRefreshPermissions}
        onRefresh={onRefreshPermissions}
        readiness={readiness}
        refreshing={refreshingPermissions}
      />
      {actions.length > 0 && (
        <div className="mt-4 grid gap-2 border-t border-subtle pt-4">
          {actions.slice(0, 5).map((action) => (
            <div
              className="flex flex-col gap-1 rounded-lg border border-subtle bg-layer-1 p-3 sm:flex-row sm:items-center"
              key={action.id}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-12 font-semibold text-primary">{action.preview.draft_pull_request.title}</p>
                <p className="mt-0.5 truncate text-12 text-secondary">
                  {action.preview.repository.full_name} · {action.preview.branch.base_ref} →{" "}
                  {action.preview.branch.head_ref}
                </p>
              </div>
              <span className="text-11 font-semibold text-tertiary">{WRITE_ACTION_STATUS_LABELS[action.status]}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const WRITE_PERMISSION_LABELS: Record<string, string> = {
  metadata: "Метаданные — чтение",
  contents: "Содержимое — создание ветки",
  pull_requests: "Pull requests — создание draft PR",
};

const WRITE_BLOCKER_LABELS: Record<TPpmGitWriteReadiness["blockers"][number], string> = {
  OWNER_DECISION_REQUIRED: "Нужно подтвердить порядок: ветка → commit/push → draft PR",
  APPLY_ENDPOINT_PENDING: "Кнопка реального применения ещё не подключена",
  PROVIDER_WRITE_DISABLED: "Внешняя запись выключена настройкой PPM",
  GITHUB_PERMISSIONS_MISSING: "GitHub App пока имеет только права чтения",
};

function GitWriteReadiness({
  canRefresh,
  onRefresh,
  readiness,
  refreshing,
}: {
  canRefresh: boolean;
  onRefresh: () => void;
  readiness: TPpmGitWriteReadiness;
  refreshing: boolean;
}) {
  return (
    <div className="mt-3 rounded-lg border border-subtle bg-layer-1 p-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-12 font-semibold text-primary">Готовность GitHub App</p>
          <p className="mt-1 text-12 leading-5 text-secondary">
            Порядок: ветка → commit → черновик PR. Каждый шаг подтверждается отдельно.
          </p>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 sm:mt-0 sm:justify-end">
          {canRefresh && (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-subtle px-2.5 py-1.5 text-12 font-semibold text-secondary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={refreshing}
              onClick={onRefresh}
            >
              <RefreshCw className={`size-3 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
              {refreshing ? "Проверяем…" : "Проверить права"}
            </button>
          )}
          <span
            className={`inline-flex w-fit items-center gap-1 rounded-full border px-2 py-1 text-11 font-semibold ${
              readiness.apply_available
                ? "border-success-subtle bg-success-subtle text-success-primary"
                : "border-warning-subtle bg-warning-subtle text-warning-primary"
            }`}
          >
            {readiness.apply_available ? <Check className="size-3" /> : <X className="size-3" />}
            {readiness.apply_available ? "Готово к применению" : "Применение закрыто"}
          </span>
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {Object.entries(readiness.required_permissions).map(([permission, level]) => {
          const ready = readiness.connections.some(
            (connection) => connection.permission_ready || connection.current_permissions[permission] === level
          );
          return (
            <div className="flex items-start gap-2 rounded-md border border-subtle bg-surface-2 p-2" key={permission}>
              {ready ? (
                <Check className="mt-0.5 size-3.5 shrink-0 text-icon-success-primary" aria-hidden="true" />
              ) : (
                <X className="mt-0.5 size-3.5 shrink-0 text-icon-warning-primary" aria-hidden="true" />
              )}
              <div>
                <p className="text-12 font-semibold text-primary">
                  {WRITE_PERMISSION_LABELS[permission] ?? permission}
                </p>
                <p className="mt-0.5 text-11 text-tertiary">Требуется: {level}</p>
              </div>
            </div>
          );
        })}
      </div>

      {readiness.connections.length > 0 && (
        <div className="mt-3 grid gap-2">
          {readiness.connections.map((connection) => (
            <div className="flex flex-wrap items-center justify-between gap-2 text-12" key={connection.connection_id}>
              <span className="font-medium text-secondary">{connection.repository_full_name}</span>
              <span className={connection.permission_ready ? "text-success-primary" : "text-warning-primary"}>
                {connection.permission_ready
                  ? "Права готовы"
                  : `Не хватает: ${connection.missing_permissions.join(", ") || "активного подключения"}`}
              </span>
            </div>
          ))}
        </div>
      )}

      {readiness.blockers.includes("GITHUB_PERMISSIONS_MISSING") && (
        <div className="mt-3 rounded-md border border-warning-subtle bg-warning-subtle p-3">
          <p className="text-12 font-semibold text-primary">Как выдать права безопасно</p>
          <ol className="mt-2 grid list-decimal gap-1 pl-4 text-12 leading-5 text-secondary">
            <li>В настройках GitHub App откройте «Permissions &amp; events» → «Repository permissions».</li>
            <li>Для «Contents» и «Pull requests» выберите «Read and write», затем сохраните изменения.</li>
            <li>В установке приложения подтвердите запрос новых прав только для нужных репозиториев.</li>
            {canRefresh ? (
              <li>Вернитесь сюда и нажмите «Проверить права».</li>
            ) : (
              <li>Попросите администратора проекта проверить права на этой странице.</li>
            )}
          </ol>
          <p className="mt-2 text-12 leading-5 text-tertiary">
            Эти права ещё ничего не создают сами по себе: ветка и draft PR потребуют отдельных подтверждений в PPM.
          </p>
        </div>
      )}

      <ul className="mt-3 grid gap-1 border-t border-subtle pt-3 text-12 leading-5 text-tertiary">
        {readiness.blockers
          .filter((blocker) => blocker !== "OWNER_DECISION_REQUIRED" && blocker !== "APPLY_ENDPOINT_PENDING")
          .map((blocker) => (
            <li className="flex gap-2" key={blocker}>
              <span aria-hidden="true">•</span>
              <span>{WRITE_BLOCKER_LABELS[blocker]}</span>
            </li>
          ))}
      </ul>
    </div>
  );
}

function GitWriteActionDialog({
  action,
  form,
  onChange,
  onClose,
  onDecision,
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
  action?: TPpmGitWriteAction;
  form: typeof EMPTY_WRITE_ACTION;
  onChange: (form: typeof EMPTY_WRITE_ACTION) => void;
  onClose: () => void;
  onDecision: (decision: "approve" | "reject") => void;
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
  if (action) {
    const preview = action.preview;
    return (
      <DialogFrame onClose={onClose} saving={saving} title="Проверка ветки и draft PR">
        <div className="grid gap-3">
          <PreviewRow label="Репозиторий" value={preview.repository.full_name} />
          <div className="grid gap-3 sm:grid-cols-2">
            <PreviewRow label="Базовая ветка" value={preview.branch.base_ref} />
            <PreviewRow label="Новая ветка" value={preview.branch.head_ref} />
          </div>
          <PreviewRow label="Связанная задача" value={`${preview.work_item.identifier} · ${preview.work_item.title}`} />
          <PreviewRow label="Название draft PR" value={preview.draft_pull_request.title} />
          <div className="rounded-lg border border-subtle bg-layer-1 p-3">
            <p className="text-11 font-semibold tracking-wide text-tertiary uppercase">Описание draft PR</p>
            <pre className="mt-2 max-h-48 overflow-auto text-12 leading-5 whitespace-pre-wrap text-secondary">
              {preview.draft_pull_request.body || "Без описания"}
            </pre>
          </div>
          <div className="rounded-lg border border-subtle bg-layer-1 p-3 text-12 leading-5 text-secondary">
            {preview.safety.message} Автоматический merge запрещён.
          </div>
          {action.error && <p className="text-12 text-danger-primary">{action.error.message}</p>}
          {action.status === "proposed" ? (
            <div className="mt-2 flex flex-wrap justify-end gap-2 border-t border-subtle pt-4">
              <button
                type="button"
                className="rounded-md border border-subtle px-3 py-2 text-12 text-primary disabled:opacity-50"
                disabled={saving}
                onClick={() => onDecision("reject")}
              >
                Отклонить
              </button>
              <button
                type="button"
                className="rounded-md bg-accent-primary px-3 py-2 text-12 font-semibold text-on-accent disabled:opacity-50"
                disabled={saving}
                onClick={() => onDecision("approve")}
              >
                {saving ? "Сохраняем…" : "Подтвердить предложение"}
              </button>
            </div>
          ) : (
            <div className="mt-2 rounded-lg border border-subtle bg-layer-1 p-3 text-12 text-secondary">
              <strong className="text-primary">{WRITE_ACTION_STATUS_LABELS[action.status]}.</strong>{" "}
              {action.status === "approved"
                ? "Решение сохранено. Репозиторий в GitHub не изменён."
                : "GitHub не изменялся."}
            </div>
          )}
        </div>
      </DialogFrame>
    );
  }

  return (
    <DialogFrame onClose={onClose} saving={saving} title="Подготовить ветку и draft PR">
      <form className="grid gap-4" onSubmit={onSubmit}>
        <label className="text-12 font-semibold text-secondary">
          Подключённый репозиторий
          <select
            className="mt-2 w-full rounded-md border border-subtle bg-surface-2 px-3 py-2 text-13 text-primary"
            value={repositoryId}
            onChange={(event) => onRepositoryChange(event.target.value)}
          >
            {repositories.map((repository) => (
              <option key={repository.id} value={repository.id}>
                {repository.provider_full_name || repository.name}
              </option>
            ))}
          </select>
        </label>
        <div>
          <label className="text-12 font-semibold text-secondary" htmlFor="ppm-git-write-work-item-search">
            Задача проекта
          </label>
          <div className="mt-2 flex gap-2">
            <input
              id="ppm-git-write-work-item-search"
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
          <FormInput
            label="Базовая ветка"
            required
            value={form.base_ref}
            onChange={(value) => onChange({ ...form, base_ref: value })}
          />
          <FormInput
            label="Новая ветка"
            placeholder="gwa-1/draft-pr"
            required
            value={form.head_ref}
            onChange={(value) => onChange({ ...form, head_ref: value })}
          />
        </div>
        <FormInput
          label="Название draft PR"
          required
          value={form.title}
          onChange={(value) => onChange({ ...form, title: value })}
        />
        <label className="text-12 font-semibold text-secondary">
          Описание draft PR
          <textarea
            className="mt-2 min-h-36 w-full resize-y rounded-md border border-subtle bg-surface-2 px-3 py-2 text-13 text-primary outline-none focus:border-accent-strong"
            maxLength={20000}
            value={form.body}
            onChange={(event) => onChange({ ...form, body: event.target.value })}
          />
        </label>
        <p className="text-12 leading-5 text-tertiary">
          На этом шаге создаётся только проверяемое предложение. GitHub, ветки и PR не изменяются.
        </p>
        <DialogActions
          disabled={!repositoryId || !selectedWorkItem || !form.base_ref || !form.head_ref || !form.title}
          onClose={onClose}
          saving={saving}
          submitLabel="Показать точный preview"
        />
      </form>
    </DialogFrame>
  );
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-subtle bg-layer-1 p-3">
      <p className="text-11 font-semibold tracking-wide text-tertiary uppercase">{label}</p>
      <p className="mt-1 text-12 font-semibold break-words text-primary">{value}</p>
    </div>
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
  const installation = installations.find((item) => item.status === "active");
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
          {connections.map((connection) => {
            const webhookStatus = getPpmGitWebhookStatus(connection);
            return (
              <div
                className="flex flex-col gap-3 rounded-lg border border-subtle bg-layer-1 p-3 sm:flex-row sm:items-center"
                key={connection.id}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-12 font-semibold text-primary">{connection.provider_full_name}</p>
                  <p className="mt-1 text-11 text-tertiary">
                    {CONNECTION_STATUS_LABELS[connection.status]}
                    {connection.last_sync_at
                      ? ` · синхронизирован ${new Date(connection.last_sync_at).toLocaleString("ru-RU")}`
                      : ""}
                  </p>
                  <p
                    className={`mt-2 inline-flex max-w-full flex-wrap items-center gap-x-1 rounded-md border px-2 py-1 text-11 ${WEBHOOK_STATUS_CLASS_NAMES[webhookStatus.tone]}`}
                    aria-label={`Статус webhook: ${webhookStatus.label}, ${webhookStatus.detail}`}
                  >
                    <span className="font-semibold">{webhookStatus.label}</span>
                    <span aria-hidden="true">·</span>
                    <span>{webhookStatus.detail}</span>
                  </p>
                  {connection.last_error && (
                    <p className="mt-1 text-12 text-danger-primary">{connection.last_error.message}</p>
                  )}
                </div>
                {canManage && !["disconnected", "revoked"].includes(connection.status) && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-md border border-subtle px-2.5 py-1.5 text-12 text-primary disabled:opacity-50"
                      disabled={saving}
                      onClick={() => onSync(connection)}
                    >
                      <RefreshCw className="size-3.5" aria-hidden="true" /> Обновить
                    </button>
                    <button
                      type="button"
                      className="rounded-md px-2.5 py-1.5 text-12 text-secondary hover:bg-danger-subtle hover:text-danger-primary"
                      disabled={saving}
                      onClick={() => onDisconnect(connection)}
                    >
                      Отключить
                    </button>
                  </div>
                )}
              </div>
            );
          })}
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
                  {repository.full_name} · {VISIBILITY_LABELS[repository.visibility]}
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

function RepositoryCard({
  canManage,
  canManageCode,
  copied,
  hasActiveConnection,
  onArchive,
  onCopy,
  onMakeDefault,
  onSyncCode,
  onToggleCode,
  projectId,
  repository,
  saving,
  workspaceSlug,
}: {
  canManage: boolean;
  canManageCode: boolean;
  copied?: string;
  hasActiveConnection: boolean;
  onArchive: (repository: TPpmGitRepository) => void;
  onCopy: (value: string, key: string) => void;
  onMakeDefault: (repository: TPpmGitRepository) => void;
  onSyncCode: (repository: TPpmGitRepository) => void;
  onToggleCode: (repository: TPpmGitRepository, enabled: boolean) => void;
  projectId: string;
  repository: TPpmGitRepository;
  saving: boolean;
  workspaceSlug: string;
}) {
  const snapshot = repository.code_index.snapshot;
  return (
    <article className="rounded-xl border border-subtle bg-surface-2 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-14 font-semibold text-primary">{repository.name}</h3>
            {repository.is_default && (
              <span className="inline-flex items-center gap-1 rounded-full bg-warning-subtle px-2 py-0.5 text-11 font-semibold text-warning-primary">
                <Star className="size-3 fill-current" aria-hidden="true" /> Основной
              </span>
            )}
          </div>
          <p className="mt-1 text-11 text-tertiary">
            {PROVIDER_LABELS[repository.provider]} · {VISIBILITY_LABELS[repository.visibility]}
            {repository.default_branch ? ` · ${repository.default_branch}` : ""}
          </p>
        </div>
        <a
          className="text-secondary hover:text-primary"
          href={repository.canonical_url}
          target="_blank"
          rel="noreferrer"
          aria-label="Открыть репозиторий"
        >
          <ExternalLink className="size-4" />
        </a>
      </div>

      <CloneRow
        copied={copied === `${repository.id}:https`}
        label="HTTPS"
        value={repository.clone_https}
        onCopy={() => void onCopy(repository.clone_https, `${repository.id}:https`)}
      />
      {repository.clone_ssh && (
        <CloneRow
          copied={copied === `${repository.id}:ssh`}
          label="SSH"
          value={repository.clone_ssh}
          onCopy={() => void onCopy(repository.clone_ssh, `${repository.id}:ssh`)}
        />
      )}

      <div className="mt-3 rounded-lg border border-subtle bg-layer-1 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-12 font-semibold text-primary">
              <Search className="size-3.5 text-accent-primary" aria-hidden="true" /> Поиск по коду
            </p>
            <p className="mt-1 text-12 leading-5 text-secondary">
              {!repository.code_index.enabled
                ? "Выключен: PPM не читает содержимое файлов."
                : snapshot
                  ? CODE_INDEX_STATUS_LABELS[snapshot.status]
                  : "Включён: первый безопасный снимок создаётся в фоне."}
            </p>
          </div>
          <span
            className={`mt-0.5 size-2 shrink-0 rounded-full bg-current ${
              snapshot?.status === "ready"
                ? "text-icon-success-primary"
                : snapshot?.status === "failed"
                  ? "text-icon-danger-primary"
                  : repository.code_index.enabled
                    ? "text-icon-warning-primary"
                    : "text-icon-tertiary"
            }`}
            aria-hidden="true"
          />
        </div>
        {repository.code_index.enabled && snapshot && (
          <div className="mt-2 text-11 leading-5 text-tertiary">
            <p>
              Ветка {snapshot.branch} · коммит {snapshot.commit_sha.slice(0, 12)}
            </p>
            {snapshot.status === "ready" && (
              <p>
                {snapshot.file_count} файлов · {formatBytes(snapshot.total_bytes)} безопасного текста
              </p>
            )}
            {snapshot.error?.message && <p className="text-danger-primary">{snapshot.error.message}</p>}
          </div>
        )}
        {canManageCode && (
          <div className="mt-3 flex flex-wrap gap-2">
            {repository.code_index.enabled ? (
              <>
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-md border border-subtle px-2.5 py-1.5 text-12 font-semibold text-primary hover:bg-layer-2 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={saving || !hasActiveConnection}
                  onClick={() => onSyncCode(repository)}
                >
                  <RefreshCw className={`size-3.5 ${saving ? "animate-spin" : ""}`} aria-hidden="true" /> Обновить
                </button>
                <button
                  type="button"
                  className="rounded-md px-2.5 py-1.5 text-12 text-secondary hover:bg-danger-subtle hover:text-danger-primary disabled:opacity-50"
                  disabled={saving}
                  onClick={() => onToggleCode(repository, false)}
                >
                  Выключить и удалить индекс
                </button>
              </>
            ) : (
              <button
                type="button"
                className="rounded-md border border-subtle px-2.5 py-1.5 text-12 font-semibold text-primary hover:bg-layer-2 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={saving || !hasActiveConnection}
                title={hasActiveConnection ? undefined : "Сначала подключите репозиторий через GitHub"}
                onClick={() => onToggleCode(repository, true)}
              >
                Включить безопасный поиск
              </button>
            )}
          </div>
        )}
        {!hasActiveConnection && canManageCode && (
          <p className="mt-2 text-12 text-tertiary">Для поиска сначала подключите этот репозиторий через GitHub.</p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-subtle pt-3">
        <Link
          className="inline-flex items-center gap-1.5 rounded-md border border-subtle px-2.5 py-1.5 text-12 font-semibold text-primary hover:bg-layer-1"
          href={gitCanvasHref(workspaceSlug, projectId, repository)}
        >
          <Code2 className="size-3.5" aria-hidden="true" /> На холст
        </Link>
        {canManage && !repository.is_default && (
          <button
            type="button"
            className="rounded-md px-2.5 py-1.5 text-12 text-secondary hover:bg-layer-1 hover:text-primary"
            onClick={() => onMakeDefault(repository)}
          >
            Сделать основным
          </button>
        )}
        {canManage && (
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-12 text-secondary hover:bg-danger-subtle hover:text-danger-primary"
            onClick={() => onArchive(repository)}
          >
            <Archive className="size-3.5" aria-hidden="true" /> Убрать
          </button>
        )}
      </div>
    </article>
  );
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} КБ`;
  return `${(value / (1024 * 1024)).toFixed(1)} МБ`;
}

function CloneRow({
  copied,
  label,
  onCopy,
  value,
}: {
  copied: boolean;
  label: string;
  onCopy: () => void;
  value: string;
}) {
  return (
    <div className="mt-3 grid grid-cols-[3.2rem_minmax(0,1fr)_2rem] items-center gap-2 rounded-md border border-subtle bg-layer-1 px-2 py-1.5">
      <span className="text-11 font-semibold text-tertiary">{label}</span>
      <code className="truncate text-12 text-secondary" title={value}>
        {value}
      </code>
      <button
        type="button"
        className="grid size-7 place-items-center rounded text-secondary hover:bg-layer-2 hover:text-primary"
        aria-label={`Копировать ${label}`}
        onClick={onCopy}
      >
        {copied ? <Check className="size-3.5 text-icon-success-primary" /> : <Clipboard className="size-3.5" />}
      </button>
    </div>
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
              {Object.entries(PROVIDER_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
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
  onClose,
  saving = false,
  title,
}: {
  children: ReactNode;
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
          <button type="button" aria-label="Закрыть" onClick={onClose}>
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        {children}
      </section>
    </ModalCore>
  );
}

function DialogActions({
  disabled,
  onClose,
  saving,
  submitLabel,
}: {
  disabled?: boolean;
  onClose: () => void;
  saving: boolean;
  submitLabel: string;
}) {
  return (
    <div className="mt-2 flex justify-end gap-2 border-t border-subtle pt-4">
      <button
        type="button"
        className="rounded-md border border-subtle px-3 py-2 text-12 text-primary"
        onClick={onClose}
      >
        Отмена
      </button>
      <button
        type="submit"
        className="rounded-md bg-accent-primary px-3 py-2 text-12 font-semibold text-on-accent disabled:opacity-50"
        disabled={saving || disabled}
      >
        {saving ? "Сохраняем…" : submitLabel}
      </button>
    </div>
  );
}

function FormInput({
  label,
  onChange,
  placeholder,
  required,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  value: string;
}) {
  return (
    <label className="text-12 font-semibold text-secondary">
      {label}
      <input
        className="mt-2 w-full rounded-md border border-subtle bg-surface-2 px-3 py-2 text-13 text-primary outline-none focus:border-accent-strong"
        placeholder={placeholder}
        required={required}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
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
