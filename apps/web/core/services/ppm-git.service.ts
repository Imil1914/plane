import { isAxiosError } from "axios";
import { API_BASE_URL } from "@plane/constants";
import { APIService } from "@/services/api.service";

export type TPpmGitProvider = "github" | "gitlab" | "bitbucket" | "gitea" | "generic";
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
  provider: "github";
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
  created_at: string;
  updated_at: string;
};

export type TPpmGitWriteAction = {
  id: string;
  action_type: "create_branch_draft_pr";
  status: TPpmGitWriteActionStatus;
  client_operation_id: string;
  preview: {
    repository: {
      id: string;
      provider: TPpmGitProvider;
      name: string;
      full_name: string;
      canonical_url: string;
    };
    provider: {
      connection_id: string;
      account_login: string;
      permissions: Record<string, string>;
      write_ready: boolean;
    };
    branch: { base_ref: string; head_ref: string };
    draft_pull_request: { title: string; body: string; is_draft: true };
    work_item: { id: string; identifier: string; title: string; updated_at: string };
    safety: { provider_write_performed: false; merge_allowed: false; message: string };
  };
  result: Record<string, unknown>;
  error: { code: string; message: string } | null;
  created_by: string;
  decided_by: string | null;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  apply_available: boolean;
};

export type TPpmGitWriteActionRequest = {
  repository_id: string;
  work_item_id: string;
  base_ref: string;
  head_ref: string;
  title: string;
  body: string;
  client_operation_id: string;
};

export type TPpmGitWriteReadiness = {
  provider: "github";
  flow: "branch_then_commit_then_draft_pr";
  decision_status: "proposed" | "accepted";
  required_permissions: Record<string, string>;
  provider_writes_enabled: boolean;
  permission_ready: boolean;
  apply_available: boolean;
  blockers: Array<
    "OWNER_DECISION_REQUIRED" | "APPLY_ENDPOINT_PENDING" | "PROVIDER_WRITE_DISABLED" | "GITHUB_PERMISSIONS_MISSING"
  >;
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
  provider: TPpmGitProviderSummary;
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

  constructor(message: string, options: { code?: string; status?: number } = {}) {
    super(message);
    this.name = "PpmGitServiceError";
    this.code = options.code;
    this.status = options.status;
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

  private gitPath(workspaceId: string, projectId: string) {
    return `/api/ppm/v1/workspaces/${workspaceId}/projects/${projectId}/git/`;
  }
}

function normalizeGitError(error: unknown) {
  if (isAxiosError(error)) {
    const payload = error.response?.data?.error as { code?: string; message?: string } | undefined;
    return new PpmGitServiceError(payload?.message ?? "Не удалось выполнить Git-операцию.", {
      code: payload?.code,
      status: error.response?.status,
    });
  }
  return error instanceof Error ? error : new PpmGitServiceError("Не удалось выполнить Git-операцию.");
}
