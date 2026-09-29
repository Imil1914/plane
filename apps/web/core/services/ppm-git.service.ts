import { isAxiosError } from "axios";
import { API_BASE_URL } from "@plane/constants";
import { APIService } from "@/services/api.service";

// G2.1: `forgejo` is our own Git server next to PPM; it is labelled on the client («Наш Git-сервер»).
export type TPpmGitProvider = "github" | "forgejo" | "gitlab" | "bitbucket" | "gitea" | "generic";
export type TPpmGitVisibility = "public" | "private" | "internal" | "unknown";
export type TPpmGitObjectType = "branch" | "commit" | "pull_request";
export type TPpmGitCodeIndexSnapshotStatus = "pending" | "ready" | "failed" | "superseded" | "revoked";
export type TPpmGitWriteActionStatus =
  | "proposed"
  | "approved"
  | "rejected"
  | "applying"
  | "applied"
  | "conflict"
  | "failed"
  | "cancelled";

export type TPpmGitCodeIndex = {
  enabled: boolean;
  branch: string;
  include_paths: string[];
  exclude_paths: string[];
  limits: {
    max_files: number;
    max_file_bytes: number;
    max_total_bytes: number;
  };
  snapshot: {
    id: string;
    branch: string;
    commit_sha: string;
    status: TPpmGitCodeIndexSnapshotStatus;
    file_count: number;
    total_bytes: number;
    excluded_stats: Record<string, number>;
    completed_at: string | null;
    error: { code: string; message: string } | null;
  } | null;
};

export type TPpmGitCapabilities = {
  read: boolean;
  manage_repositories: boolean;
  manage_links: boolean;
  manage_provider: boolean;
  manage_write_actions: boolean;
  /** G2.1: only a PPM global administrator connects and disconnects repositories of our Git server. Absent on an
   * older API — then nobody may. */
  manage_git_server?: boolean;
  /** G2.2 (R17): true for a PPM global administrator, and also for a project administrator once single sign-on is
   * configured for our Git server — this is the capability the «Код» page's connect/disconnect button actually
   * follows. Absent on an older API — then `manage_git_server` alone decides (G2.1 behaviour, SSO off). */
  connect_git_server_repositories?: boolean;
};

/** G2.1: which Git providers this PPM is set up for. Absent on an older API — then only `provider` (GitHub) is known. */
export type TPpmGitProviders = {
  github?: { configured: boolean };
  forgejo?: {
    configured: boolean;
    public_url: string | null;
    /** G2.2: single sign-on through PPM is configured for our Git server. Absent on an older API — then off. */
    sso_enabled?: boolean;
    /** G2.2: the viewer's own username on our Git server, or null without a personal account there yet. */
    username?: string | null;
    /** G2.2: one-click sign-in link (`${PPM_FORGEJO_PUBLIC_URL}/user/oauth2/PPM`), or null without single sign-on. */
    sso_login_url?: string | null;
  };
};

export type TPpmGitProviderSummary = {
  provider: "github";
  configured: boolean;
  mode: "github_app";
  permissions: Record<string, string>;
  events: string[];
};

export type TPpmGitInstallation = {
  id: string;
  /** G2.1: a project connected to our Git server also has one `forgejo` installation row. */
  provider: TPpmGitProvider;
  account_login: string;
  account_type: string;
  repository_selection: string;
  permissions: Record<string, string>;
  events: string[];
  status: "active" | "suspended" | "revoked";
  created_at: string;
  updated_at: string;
};

export type TPpmGitConnection = {
  id: string;
  repository_id: string;
  installation_id: string;
  provider_repository_id: number;
  provider_full_name: string;
  status:
    | "active"
    | "syncing"
    | "rate_limited"
    | "permission_drift"
    | "error"
    | "suspended"
    | "disconnected"
    | "revoked";
  last_sync_at: string | null;
  last_event_at: string | null;
  last_error: { code: string; message: string } | null;
  retry_after: string | null;
  created_at: string;
  updated_at: string;
};

export type TPpmGitObject = {
  id: string;
  repository_id: string;
  connection_id: string;
  object_type: TPpmGitObjectType;
  ref: string;
  title: string;
  canonical_url: string;
  state: string;
  is_draft: boolean;
  author_name: string;
  author_avatar_url: string;
  base_ref: string;
  head_ref: string;
  commit_sha: string;
  is_active: boolean;
  provider_updated_at: string | null;
  /** G2.1 M-1/M-2: true time of the merge (`PpmGitObject.provider_merged_at`), only ever set on a merged PR — null
   * for branches, commits and open/closed PRs. Optional: an older cached response may not have it yet. */
  provider_merged_at?: string | null;
  last_seen_at: string;
};

export type TPpmGitHubRepository = {
  provider_repository_id: number;
  name: string;
  full_name: string;
  owner: string;
  canonical_url: string;
  clone_https: string;
  clone_ssh: string;
  default_branch: string;
  visibility: TPpmGitVisibility;
  archived: boolean;
  updated_at: string | null;
};

/** G2.1: a repository on our Git server (Forgejo) as the connect dialog lists it. */
export type TPpmForgejoRepository = {
  provider_repository_id: number;
  full_name: string;
  name: string;
  owner: string;
  description: string | null;
  private: boolean;
  archived: boolean;
  default_branch: string;
  html_url: string;
  clone_https: string;
  /** Empty or null when SSH is switched off on the Git server. */
  clone_ssh: string | null;
  updated_at: string | null;
  /** Already connected to this project: the dialog shows it, but does not offer it again. */
  connected: boolean;
};

export type TPpmForgejoRepositoryPage = {
  results: TPpmForgejoRepository[];
  page: number;
  has_next: boolean;
};

export type TPpmGitRepository = {
  id: string;
  name: string;
  provider: TPpmGitProvider;
  provider_repository_id: number | null;
  provider_full_name: string;
  canonical_url: string;
  clone_https: string;
  clone_ssh: string;
  default_branch: string;
  visibility: TPpmGitVisibility;
  is_default: boolean;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
  code_index: TPpmGitCodeIndex;
};

export type TPpmGitLink = {
  id: string;
  repository_id: string;
  repository_name: string;
  repository_provider: TPpmGitProvider;
  work_item: {
    id: string;
    identifier: string;
    title: string;
  };
  object_type: TPpmGitObjectType;
  ref: string;
  title: string;
  canonical_url: string;
  status: "active" | "unlinked";
  origin: "manual" | "provider";
  git_object_id: string | null;
  /** G2.1 D-3: state of the linked Git object («open», «closed», «merged» for a PR); null without one. Already sent
   * by the API (`serialize_link`) but missing from this type until now — added so «Код» can show it on PR rows. */
  git_object_state: string | null;
  /** G2.1 M-1/M-2: true time of the merge, in the naming style of the field above (`git_object_*`); only ever set
   * when `git_object_state` is «merged» — null otherwise, and without a Git object. Optional: an older cached
   * response may not have it yet. */
  git_object_merged_at?: string | null;
  created_at: string;
  updated_at: string;
};

// G1.3 (RC-C): two separately approved steps — a branch, then (after the first push) a draft PR.
export type TPpmGitWriteActionType = "create_branch" | "create_draft_pr" | "create_branch_draft_pr";
export type TPpmGitWriteActionStage = "branch" | "pull_request" | "legacy";
export type TPpmGitWriteApplyBlocker =
  | "LEGACY_FLOW"
  | "STATUS_FINAL"
  | "APPLY_IN_PROGRESS"
  | "APPROVAL_REQUIRED"
  | "RETRY_LATER"
  | "PROVIDER_WRITE_DISABLED"
  | "CONNECTION_INACTIVE"
  | "GITHUB_PERMISSIONS_MISSING";

export type TPpmGitWriteCommit = { sha: string; title: string; author: string; canonical_url: string };

export type TPpmGitWritePreview = {
  /** Absent on legacy single-step proposals. */
  stage?: "branch" | "pull_request";
  repository: {
    id: string;
    provider: TPpmGitProvider;
    name: string;
    full_name: string;
    canonical_url: string;
  };
  provider: {
    connection_id: string;
    installation_id?: string;
    account_login: string;
    permissions: Record<string, string>;
    write_ready: boolean;
  };
  branch: { base_ref: string; base_sha?: string; head_ref: string; head_sha?: string; canonical_url?: string };
  /**
   * Branch step: the planned PR text (created only by step 2). Draft PR step: exactly what will be created — the
   * body plus the hidden per-action `marker` (HTML comment) by which PPM recognises only its own PR on a retry.
   */
  draft_pull_request: { title: string; body: string; is_draft: true; planned?: boolean; marker?: string };
  commits?: { ahead_by: number; truncated: boolean; items: TPpmGitWriteCommit[] };
  /** Closed or merged PRs for the same branches: they do not block a new draft PR, shown for reference. */
  previous_pull_requests?: Array<{
    provider_object_id: string;
    number: string;
    title: string;
    canonical_url: string;
    state: string;
    is_draft: boolean;
  }>;
  work_item: { id: string; identifier: string; title: string; updated_at: string };
  parent_action_id?: string;
  safety: { provider_write_performed: false; merge_allowed: false; message: string };
};

export type TPpmGitWriteResult = {
  branch?: { ref: string; sha: string; canonical_url: string; created: boolean };
  pull_request?: {
    provider_object_id: string;
    number: string;
    canonical_url: string;
    is_draft: boolean;
    state: string;
    base_ref: string;
    head_ref: string;
    head_sha: string;
    created: boolean;
  };
  git_object_id?: string | null;
  link_id?: string | null;
  error_details?: { canonical_url?: string };
  /** An interrupted attempt may have written to GitHub; only a reconciling retry is allowed. */
  outcome_unknown?: boolean;
  first_attempt_at?: string;
};

export type TPpmGitWriteAction = {
  id: string;
  action_type: TPpmGitWriteActionType;
  stage: TPpmGitWriteActionStage;
  status: TPpmGitWriteActionStatus;
  client_operation_id: string;
  parent_action_id: string | null;
  base_sha: string;
  head_sha: string;
  preview: TPpmGitWritePreview;
  result: TPpmGitWriteResult;
  error: { code: string; message: string } | null;
  created_by: string;
  decided_by: string | null;
  applied_by: string | null;
  cancelled_by: string | null;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  applied_at: string | null;
  cancelled_at: string | null;
  apply_attempts: number;
  retry_after: string | null;
  apply_available: boolean;
  apply_blockers: TPpmGitWriteApplyBlocker[];
  can_cancel: boolean;
  outcome_unknown: boolean;
  follow_up: {
    pull_request_ready: boolean;
    branch_head_sha: string | null;
    branch_active: boolean;
    pull_request_action: { id: string; status: TPpmGitWriteActionStatus } | null;
  } | null;
};

export type TPpmGitBranchActionRequest = {
  action_type: "create_branch";
  repository_id: string;
  work_item_id: string;
  base_ref: string;
  head_ref: string;
  title: string;
  body: string;
  client_operation_id: string;
};

export type TPpmGitPullRequestActionRequest = {
  action_type: "create_draft_pr";
  parent_action_id: string;
  title: string;
  body: string;
  client_operation_id: string;
};

export type TPpmGitWriteActionRequest = TPpmGitBranchActionRequest | TPpmGitPullRequestActionRequest;

export type TPpmGitWriteReadiness = {
  provider: "github";
  flow: "branch_then_commit_then_draft_pr";
  decision_status: "proposed" | "accepted";
  required_permissions: Record<string, string>;
  provider_writes_enabled: boolean;
  permission_ready: boolean;
  apply_available: boolean;
  blockers: Array<"PROVIDER_WRITE_DISABLED" | "GITHUB_PERMISSIONS_MISSING">;
  connections: Array<{
    connection_id: string;
    repository_id: string;
    repository_full_name: string;
    connection_status: TPpmGitConnection["status"];
    current_permissions: Record<string, string>;
    missing_permissions: string[];
    permission_ready: boolean;
  }>;
};

export type TPpmGitOverview = {
  capabilities: TPpmGitCapabilities;
  /** The GitHub App summary (kept for the RC.1 clients). */
  provider: TPpmGitProviderSummary;
  providers?: TPpmGitProviders;
  repositories: TPpmGitRepository[];
  installations: TPpmGitInstallation[];
  connections: TPpmGitConnection[];
  objects: TPpmGitObject[];
  links: TPpmGitLink[];
  write_actions: {
    provider_writes_enabled: boolean;
    apply_available: boolean;
    readiness: TPpmGitWriteReadiness;
    items: TPpmGitWriteAction[];
  };
  conventions: {
    branch: string;
    commit: string;
    pull_request: string;
  };
};

export type TPpmGitRepositoryRequest = {
  name: string;
  provider: TPpmGitProvider;
  canonical_url: string;
  clone_https: string;
  clone_ssh: string;
  default_branch: string;
  visibility: TPpmGitVisibility;
  is_default: boolean;
};

export type TPpmGitLinkRequest = {
  repository_id: string;
  work_item_id: string;
  object_type: TPpmGitObjectType;
  ref: string;
  title: string;
  canonical_url: string;
};

export class PpmGitServiceError extends Error {
  code?: string;
  status?: number;
  details?: Record<string, unknown>;

  constructor(message: string, options: { code?: string; status?: number; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = "PpmGitServiceError";
    this.code = options.code;
    this.status = options.status;
    this.details = options.details;
  }
}

export class PpmGitService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  async getOverview(workspaceId: string, projectId: string): Promise<TPpmGitOverview> {
    try {
      const response = await this.get(this.gitPath(workspaceId, projectId));
      return response.data as TPpmGitOverview;
    } catch (error) {
      throw normalizeGitError(error);
    }
  }

  async startGithubConnect(workspaceId: string, projectId: string): Promise<{ authorization_url: string }> {
    try {
      const response = await this.post(`${this.gitPath(workspaceId, projectId)}providers/github/start/`);
      return response.data as { authorization_url: string };
    } catch (error) {
      throw normalizeGitError(error);
    }
  }

  async getGithubRepositories(
    workspaceId: string,
    projectId: string,
    installationId: string
  ): Promise<TPpmGitHubRepository[]> {
    try {
      const response = await this.get(
        `${this.gitPath(workspaceId, projectId)}providers/github/installations/${installationId}/repositories/`
      );
      return (response.data as { repositories: TPpmGitHubRepository[] }).repositories;
    } catch (error) {
      throw normalizeGitError(error);
    }
  }

  async refreshGithubInstallation(
    workspaceId: string,
    projectId: string,
    installationId: string
  ): Promise<{ installation: TPpmGitInstallation; readiness: TPpmGitWriteReadiness }> {
    try {
      const response = await this.post(
        `${this.gitPath(workspaceId, projectId)}providers/github/installations/${installationId}/refresh/`
      );
      return response.data as { installation: TPpmGitInstallation; readiness: TPpmGitWriteReadiness };
    } catch (error) {
      throw normalizeGitError(error);
    }
  }

  async connectGithubRepository(
    workspaceId: string,
    projectId: string,
    installationId: string,
    providerRepositoryId: number
  ): Promise<TPpmGitConnection> {
    try {
      const response = await this.post(`${this.gitPath(workspaceId, projectId)}providers/github/repositories/`, {
        installation_id: installationId,
        provider_repository_id: providerRepositoryId,
      });
      return response.data as TPpmGitConnection;
    } catch (error) {
      throw normalizeGitError(error);
    }
  }

  /** G2.1: repositories of our Git server (only a PPM global administrator may list them). */
  async listForgejoRepositories(
    workspaceId: string,
    projectId: string,
    { search = "", page = 1 }: { search?: string; page?: number } = {}
  ): Promise<TPpmForgejoRepositoryPage> {
    const query = search.trim();
    try {
      const response = await this.get(this.forgejoRepositoriesPath(workspaceId, projectId), {
        params: query ? { search: query, page } : { page },
      });
      const payload = response.data as Partial<TPpmForgejoRepositoryPage> | undefined;
      return {
        results: Array.isArray(payload?.results) ? payload.results : [],
        page: typeof payload?.page === "number" ? payload.page : page,
        has_next: payload?.has_next === true,
      };
    } catch (error) {
      throw normalizeForgejoError(error);
    }
  }

  /** G2.1: connect a repository of our Git server to the project (PPM global administrator only). */
  async connectForgejoRepository(
    workspaceId: string,
    projectId: string,
    providerRepositoryId: number
  ): Promise<{ repository: TPpmGitRepository; connection: TPpmGitConnection }> {
    try {
      const response = await this.post(this.forgejoRepositoriesPath(workspaceId, projectId), {
        provider_repository_id: providerRepositoryId,
      });
      return response.data as { repository: TPpmGitRepository; connection: TPpmGitConnection };
    } catch (error) {
      throw normalizeForgejoError(error);
    }
  }

  async syncConnection(workspaceId: string, projectId: string, connectionId: string) {
    try {
      await this.post(`${this.gitPath(workspaceId, projectId)}connections/${connectionId}/`);
    } catch (error) {
      throw normalizeGitError(error);
    }
  }

  async disconnectConnection(workspaceId: string, projectId: string, connectionId: string) {
    try {
      await this.delete(`${this.gitPath(workspaceId, projectId)}connections/${connectionId}/`);
    } catch (error) {
      throw normalizeGitError(error);
    }
  }

  async createRepository(
    workspaceId: string,
    projectId: string,
    request: TPpmGitRepositoryRequest
  ): Promise<TPpmGitRepository> {
    try {
      const response = await this.post(`${this.gitPath(workspaceId, projectId)}repositories/`, request);
      return response.data as TPpmGitRepository;
    } catch (error) {
      throw normalizeGitError(error);
    }
  }

  async updateRepository(
    workspaceId: string,
    projectId: string,
    repositoryId: string,
    request: Partial<TPpmGitRepositoryRequest>
  ): Promise<TPpmGitRepository> {
    try {
      const response = await this.patch(
        `${this.gitPath(workspaceId, projectId)}repositories/${repositoryId}/`,
        request
      );
      return response.data as TPpmGitRepository;
    } catch (error) {
      throw normalizeGitError(error);
    }
  }

  async archiveRepository(workspaceId: string, projectId: string, repositoryId: string) {
    try {
      await this.delete(`${this.gitPath(workspaceId, projectId)}repositories/${repositoryId}/`);
    } catch (error) {
      throw normalizeGitError(error);
    }
  }

  async updateCodeIndexPolicy(
    workspaceId: string,
    projectId: string,
    repositoryId: string,
    request: Pick<TPpmGitCodeIndex, "enabled" | "branch"> &
      Partial<Pick<TPpmGitCodeIndex, "include_paths" | "exclude_paths">>
  ): Promise<TPpmGitCodeIndex> {
    try {
      const response = await this.patch(
        `${this.gitPath(workspaceId, projectId)}repositories/${repositoryId}/code-index/`,
        request
      );
      return response.data as TPpmGitCodeIndex;
    } catch (error) {
      throw normalizeGitError(error);
    }
  }

  async syncCodeIndex(workspaceId: string, projectId: string, repositoryId: string): Promise<TPpmGitCodeIndex> {
    try {
      const response = await this.post(
        `${this.gitPath(workspaceId, projectId)}repositories/${repositoryId}/code-index/`
      );
      return (response.data as { code_index: TPpmGitCodeIndex }).code_index;
    } catch (error) {
      throw normalizeGitError(error);
    }
  }

  async createLink(workspaceId: string, projectId: string, request: TPpmGitLinkRequest): Promise<TPpmGitLink> {
    try {
      const response = await this.post(`${this.gitPath(workspaceId, projectId)}links/`, request);
      return response.data as TPpmGitLink;
    } catch (error) {
      throw normalizeGitError(error);
    }
  }

  async unlink(workspaceId: string, projectId: string, linkId: string) {
    try {
      await this.delete(`${this.gitPath(workspaceId, projectId)}links/${linkId}/`);
    } catch (error) {
      throw normalizeGitError(error);
    }
  }

  async createWriteActionPreview(
    workspaceId: string,
    projectId: string,
    request: TPpmGitWriteActionRequest
  ): Promise<TPpmGitWriteAction> {
    try {
      const response = await this.post(`${this.gitPath(workspaceId, projectId)}write-actions/`, request);
      return response.data as TPpmGitWriteAction;
    } catch (error) {
      throw normalizeGitError(error);
    }
  }

  async getWriteAction(workspaceId: string, projectId: string, actionId: string): Promise<TPpmGitWriteAction> {
    try {
      const response = await this.get(`${this.gitPath(workspaceId, projectId)}write-actions/${actionId}/`);
      return response.data as TPpmGitWriteAction;
    } catch (error) {
      throw normalizeGitError(error);
    }
  }

  async decideWriteAction(
    workspaceId: string,
    projectId: string,
    actionId: string,
    decision: "approve" | "reject"
  ): Promise<TPpmGitWriteAction> {
    try {
      const response = await this.post(`${this.gitPath(workspaceId, projectId)}write-actions/${actionId}/decision/`, {
        decision,
      });
      return response.data as TPpmGitWriteAction;
    } catch (error) {
      throw normalizeGitError(error);
    }
  }

  /** G1.3: create the approved branch or draft PR in GitHub (refused while PPM_GIT_WRITE_ENABLED is off). */
  async applyWriteAction(workspaceId: string, projectId: string, actionId: string): Promise<TPpmGitWriteAction> {
    try {
      const response = await this.post(`${this.gitPath(workspaceId, projectId)}write-actions/${actionId}/apply/`);
      return response.data as TPpmGitWriteAction;
    } catch (error) {
      throw normalizeGitError(error);
    }
  }

  async cancelWriteAction(workspaceId: string, projectId: string, actionId: string): Promise<TPpmGitWriteAction> {
    try {
      const response = await this.post(`${this.gitPath(workspaceId, projectId)}write-actions/${actionId}/cancel/`);
      return response.data as TPpmGitWriteAction;
    } catch (error) {
      throw normalizeGitError(error);
    }
  }

  private gitPath(workspaceId: string, projectId: string) {
    return `/api/ppm/v1/workspaces/${workspaceId}/projects/${projectId}/git/`;
  }

  private forgejoRepositoriesPath(workspaceId: string, projectId: string) {
    return `${this.gitPath(workspaceId, projectId)}providers/forgejo/repositories/`;
  }
}

// G2.1: the contract errors of our Git server in plain Russian. The code wins over the status: a not-configured
// server answers 400 like any invalid request.
const PPM_FORGEJO_ERROR_MESSAGES = {
  // G2.2 review round 1 (#7): under single sign-on a project administrator may also connect (R17) — a flat "only
  // the PPM administrator" would misinform them about their own 403 (e.g. no Forgejo-admin rights on that org yet).
  forbidden: "Подключать репозитории может только администратор проекта или администратор PPM.",
  notConfigured: "Git-сервер не настроен.",
  rateLimited: "Git-сервер просит подождать. Повторите чуть позже.",
  unavailable: "Git-сервер не отвечает. Повторите чуть позже.",
  conflict: "Репозиторий уже подключён.",
  notFound: "Репозиторий не найден на Git-сервере. Обновите список.",
  offline: "Нет связи с PPM. Проверьте подключение и повторите.",
  fallback: "Не удалось выполнить операцию с Git-сервером.",
  /** G2.2 (R17): the actor has no personal account on our Git server yet (single sign-on required first) — a 409
   * that must not fall into the generic `conflict` branch below (the code, not the status, tells them apart). The
   * picker's list error additionally shows this with a `sso_login_url` link (`ForgejoRepositoryResults`); this
   * string is the fallback for the plain-text surfaces (the connect button's own error banner). */
  accountRequired: "Сначала войдите на Git-сервер кнопкой «Войти через PPM» — здесь появятся ваши репозитории.",
} as const;

export function getPpmForgejoErrorMessage({
  code,
  message,
  status,
}: {
  code?: string;
  message?: string;
  status?: number;
}): string {
  if (code === "FORGEJO_NOT_CONFIGURED") return PPM_FORGEJO_ERROR_MESSAGES.notConfigured;
  if (code === "FORGEJO_ACCOUNT_REQUIRED") return PPM_FORGEJO_ERROR_MESSAGES.accountRequired;
  if (code === "GIT_PERMISSION_DENIED" || status === 403) return PPM_FORGEJO_ERROR_MESSAGES.forbidden;
  if (code === "GIT_PROVIDER_RATE_LIMITED" || status === 429) return PPM_FORGEJO_ERROR_MESSAGES.rateLimited;
  if (code === "GIT_PROVIDER_UNAVAILABLE" || status === 502) return PPM_FORGEJO_ERROR_MESSAGES.unavailable;
  if (code === "GIT_REPOSITORY_CONFLICT" || status === 409) return PPM_FORGEJO_ERROR_MESSAGES.conflict;
  if (code === "GIT_REPOSITORY_NOT_FOUND" || status === 404) return PPM_FORGEJO_ERROR_MESSAGES.notFound;
  return message || PPM_FORGEJO_ERROR_MESSAGES.fallback;
}

function normalizeForgejoError(error: unknown) {
  if (!isAxiosError(error)) return new PpmGitServiceError(PPM_FORGEJO_ERROR_MESSAGES.fallback);
  if (!error.response) return new PpmGitServiceError(PPM_FORGEJO_ERROR_MESSAGES.offline);
  const payload = error.response.data?.error as
    | { code?: string; message?: string; details?: Record<string, unknown> }
    | undefined;
  const status = error.response.status;
  return new PpmGitServiceError(getPpmForgejoErrorMessage({ code: payload?.code, message: payload?.message, status }), {
    code: payload?.code,
    status,
    details: payload?.details,
  });
}

function normalizeGitError(error: unknown) {
  if (isAxiosError(error)) {
    const payload = error.response?.data?.error as
      | { code?: string; message?: string; details?: Record<string, unknown> }
      | undefined;
    return new PpmGitServiceError(payload?.message ?? "Не удалось выполнить Git-операцию.", {
      code: payload?.code,
      status: error.response?.status,
      details: payload?.details,
    });
  }
  return error instanceof Error ? error : new PpmGitServiceError("Не удалось выполнить Git-операцию.");
}
