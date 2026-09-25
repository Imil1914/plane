import { isAxiosError } from "axios";
import { API_BASE_URL } from "@plane/constants";
import { APIService } from "@/services/api.service";

const PPM_ASSET_API_BASE_URL = import.meta.env.VITE_API_BASE_URL || API_BASE_URL;

export type TPpmVaultAccess = "edit" | "read";
export type TPpmVaultEntryKind = "folder" | "markdown" | "pdf" | "image" | "file";
export type TPpmVaultIndexPolicy = "inherit" | "include" | "exclude";

export type TPpmVaultEntry = {
  children?: TPpmVaultEntry[];
  content_hash: string;
  created_at: string;
  extension: string;
  id: string;
  index_policy: TPpmVaultIndexPolicy;
  kind: TPpmVaultEntryKind;
  mime_type: string;
  name: string;
  parent_id: string | null;
  path: string;
  size_bytes: number;
  status: "active" | "quarantined" | "trashed";
  updated_at: string;
  version: number;
};

export type TPpmVault = {
  access: TPpmVaultAccess;
  entries: TPpmVaultEntry[];
  index_policy_values: TPpmVaultIndexPolicy[];
  name: string;
  project_id: string;
  root_entry_id: string;
  vault_id: string;
};

export type TPpmVaultMarkdown = {
  access: TPpmVaultAccess;
  content: string;
  entry: TPpmVaultEntry;
};

export type TPpmVaultLink = {
  id: string;
  normalized_target: string;
  raw_target: string;
  source_entry_id: string;
  source_version: number;
  status: "resolved" | "missing" | "ambiguous";
  target_entry_id: string | null;
};

export type TPpmVaultBacklinks = {
  entry: TPpmVaultEntry;
  incoming: Array<TPpmVaultLink & { source_entry: TPpmVaultEntry }>;
  outgoing: Array<TPpmVaultLink & { target_entry: TPpmVaultEntry | null }>;
};

export type TPpmVaultGraph = { edges: TPpmVaultLink[]; nodes: TPpmVaultEntry[] };

export type TPpmVaultVersion = {
  content_hash: string;
  created_at: string;
  created_by: string;
  current: boolean;
  mime_type: string;
  size_bytes: number;
  version: number;
};

export type TPpmVaultProjectPage = { id: string; name: string; updated_at: string };

export type TPpmVaultTransfer = {
  created_at: string;
  created_by: string;
  direction: "page_to_vault" | "vault_to_page";
  entry_id: string;
  entry_version: number;
  id: string;
  page_id: string;
  page_version: string;
};

// AF2.1 B5: превью файла, построенное сервером (S): Office → html/листы/слайды, текст → text. HTML уже санитизирован
// сервером; клиент всё равно пропускает его через DOMPurify. `unsupported` несёт причину (reason): type, binary,
// too_large, limits, encrypted, invalid (apps/api/plane/ppm_vault/preview.py).
export type TPpmVaultPreview = {
  encoding?: string;
  html?: string;
  kind: "docx" | "pptx" | "text" | "unsupported" | "xlsx";
  reason?: string;
  sheets?: Array<{ name: string; rows: string[][] }>;
  slides?: Array<{ index: number; text: string; title: string }>;
  text?: string;
  truncated: boolean;
};

/** AF2.1 B5: отмена запроса (диалог просмотра закрыт — запрос прерывается). */
export type TPpmVaultRequestOptions = { signal?: AbortSignal };

export class PpmVaultServiceError extends Error {
  code?: string;
  status?: number;
  // AF2.1 B4 (round 1): server-sent conflict/limit context (e.g. VAULT_NAME_CONFLICT's suggested_name,
  // VAULT_FILE_TOO_LARGE's size_bytes/limit_bytes) — optional, existing callers passing only {code, status} keep working.
  details?: Record<string, unknown>;

  constructor(message: string, options: { code?: string; status?: number; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = "PpmVaultServiceError";
    this.code = options.code;
    this.status = options.status;
    this.details = options.details;
  }
}

export class PpmVaultService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  async getVault(workspaceId: string, projectId: string): Promise<TPpmVault> {
    try {
      const response = await this.get(this.vaultPath(workspaceId, projectId));
      return response.data as TPpmVault;
    } catch (error) {
      throw normalizeVaultError(error);
    }
  }

  async createFolder(workspaceId: string, projectId: string, name: string, parentId?: string) {
    try {
      const response = await this.post(`${this.vaultPath(workspaceId, projectId)}folders/`, {
        name,
        parent_id: parentId,
      });
      return response.data as TPpmVaultEntry;
    } catch (error) {
      throw normalizeVaultError(error);
    }
  }

  async createMarkdown(workspaceId: string, projectId: string, name: string, parentId?: string) {
    try {
      const response = await this.post(`${this.vaultPath(workspaceId, projectId)}markdown/`, {
        name,
        parent_id: parentId,
        content: "",
      });
      return response.data as TPpmVaultEntry;
    } catch (error) {
      throw normalizeVaultError(error);
    }
  }

  async getMarkdown(
    workspaceId: string,
    projectId: string,
    entryId: string,
    options: TPpmVaultRequestOptions = {}
  ): Promise<TPpmVaultMarkdown> {
    try {
      const response = await this.get(
        `${this.entryPath(workspaceId, projectId, entryId)}content/`,
        {},
        {
          signal: options.signal,
        }
      );
      return response.data as TPpmVaultMarkdown;
    } catch (error) {
      throw normalizeVaultError(error);
    }
  }

  async saveMarkdown(workspaceId: string, projectId: string, entryId: string, baseVersion: number, content: string) {
    try {
      const response = await this.put(`${this.entryPath(workspaceId, projectId, entryId)}content/`, {
        base_version: baseVersion,
        content,
      });
      return response.data as TPpmVaultEntry;
    } catch (error) {
      throw normalizeVaultError(error);
    }
  }

  async uploadPdf(workspaceId: string, projectId: string, file: File, parentId?: string) {
    try {
      const body = new FormData();
      body.append("file", file);
      if (parentId) body.append("parent_id", parentId);
      const response = await this.post(`${this.vaultPath(workspaceId, projectId)}pdf/`, body, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return response.data as TPpmVaultEntry;
    } catch (error) {
      throw normalizeVaultError(error);
    }
  }

  async uploadFile(workspaceId: string, projectId: string, file: File, parentId?: string) {
    try {
      const body = new FormData();
      body.append("file", file);
      if (parentId) body.append("parent_id", parentId);
      const response = await this.post(`${this.vaultPath(workspaceId, projectId)}files/`, body, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return response.data as TPpmVaultEntry;
    } catch (error) {
      throw normalizeVaultError(error);
    }
  }

  async replaceFile(workspaceId: string, projectId: string, entryId: string, baseVersion: number, file: File) {
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("base_version", String(baseVersion));
      const response = await this.put(`${this.entryPath(workspaceId, projectId, entryId)}file/`, body, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return response.data as TPpmVaultEntry;
    } catch (error) {
      throw normalizeVaultError(error);
    }
  }

  async setIndexPolicy(workspaceId: string, projectId: string, entryId: string, indexPolicy: TPpmVaultIndexPolicy) {
    try {
      const response = await this.patch(this.entryPath(workspaceId, projectId, entryId), {
        index_policy: indexPolicy,
      });
      return response.data as TPpmVaultEntry;
    } catch (error) {
      throw normalizeVaultError(error);
    }
  }

  async updateEntry(
    workspaceId: string,
    projectId: string,
    entryId: string,
    payload: { name?: string; parent_id?: string | null }
  ) {
    try {
      const response = await this.patch(this.entryPath(workspaceId, projectId, entryId), payload);
      return response.data as TPpmVaultEntry;
    } catch (error) {
      throw normalizeVaultError(error);
    }
  }

  async trashEntry(workspaceId: string, projectId: string, entryId: string) {
    try {
      await this.delete(this.entryPath(workspaceId, projectId, entryId));
    } catch (error) {
      throw normalizeVaultError(error);
    }
  }

  async getTrash(workspaceId: string, projectId: string) {
    try {
      const response = await this.get(`${this.vaultPath(workspaceId, projectId)}trash/`);
      return response.data as { entries: TPpmVaultEntry[] };
    } catch (error) {
      throw normalizeVaultError(error);
    }
  }

  async restoreEntry(workspaceId: string, projectId: string, entryId: string) {
    try {
      const response = await this.post(`${this.entryPath(workspaceId, projectId, entryId)}restore/`, {});
      return response.data as TPpmVaultEntry;
    } catch (error) {
      throw normalizeVaultError(error);
    }
  }

  async getBacklinks(workspaceId: string, projectId: string, entryId: string) {
    try {
      const response = await this.get(`${this.entryPath(workspaceId, projectId, entryId)}backlinks/`);
      return response.data as TPpmVaultBacklinks;
    } catch (error) {
      throw normalizeVaultError(error);
    }
  }

  async getGraph(workspaceId: string, projectId: string) {
    try {
      const response = await this.get(`${this.vaultPath(workspaceId, projectId)}graph/`);
      return response.data as TPpmVaultGraph;
    } catch (error) {
      throw normalizeVaultError(error);
    }
  }

  async getVersions(workspaceId: string, projectId: string, entryId: string) {
    try {
      const response = await this.get(`${this.entryPath(workspaceId, projectId, entryId)}versions/`);
      return response.data as { entry: TPpmVaultEntry; versions: TPpmVaultVersion[] };
    } catch (error) {
      throw normalizeVaultError(error);
    }
  }

  async restoreVersion(workspaceId: string, projectId: string, entryId: string, version: number, baseVersion: number) {
    try {
      const response = await this.post(
        `${this.entryPath(workspaceId, projectId, entryId)}versions/${version}/restore/`,
        {
          base_version: baseVersion,
        }
      );
      return response.data as TPpmVaultEntry;
    } catch (error) {
      throw normalizeVaultError(error);
    }
  }

  async getTransferPages(workspaceId: string, projectId: string) {
    try {
      const response = await this.get(`${this.vaultPath(workspaceId, projectId)}transfers/pages/`);
      return response.data as { pages: TPpmVaultProjectPage[] };
    } catch (error) {
      throw normalizeVaultError(error);
    }
  }

  async importPage(workspaceId: string, projectId: string, pageId: string, parentId?: string) {
    try {
      const response = await this.post(`${this.vaultPath(workspaceId, projectId)}transfers/pages/${pageId}/import/`, {
        parent_id: parentId,
      });
      return response.data as { entry: TPpmVaultEntry; transfer: TPpmVaultTransfer };
    } catch (error) {
      throw normalizeVaultError(error);
    }
  }

  async exportMarkdownToPage(workspaceId: string, projectId: string, entryId: string) {
    try {
      const response = await this.post(`${this.entryPath(workspaceId, projectId, entryId)}export-page/`, {});
      return response.data as { page: TPpmVaultProjectPage; transfer: TPpmVaultTransfer };
    } catch (error) {
      throw normalizeVaultError(error);
    }
  }

  async getTransfers(workspaceId: string, projectId: string, entryId: string) {
    try {
      const response = await this.get(`${this.entryPath(workspaceId, projectId, entryId)}transfers/`);
      return response.data as { transfers: TPpmVaultTransfer[] };
    } catch (error) {
      throw normalizeVaultError(error);
    }
  }

  // ── AF2.1 B5: просмотр и скачивание файла с холста ──
  async getPreview(
    workspaceId: string,
    projectId: string,
    entryId: string,
    options: TPpmVaultRequestOptions = {}
  ): Promise<TPpmVaultPreview> {
    try {
      const response = await this.get(
        `${this.vaultPath(workspaceId, projectId)}entries/${entryId}/preview/`,
        {},
        {
          signal: options.signal,
        }
      );
      return response.data as TPpmVaultPreview;
    } catch (error) {
      throw normalizeVaultError(error);
    }
  }

  async getFileText(
    workspaceId: string,
    projectId: string,
    entryId: string,
    options: TPpmVaultRequestOptions = {}
  ): Promise<string> {
    try {
      const response = await this.get(
        `${this.entryPath(workspaceId, projectId, entryId)}file/`,
        {},
        {
          responseType: "text",
          signal: options.signal,
          transformResponse: [(data: unknown) => data],
        }
      );
      return String(response.data ?? "");
    } catch (error) {
      throw await normalizeVaultRawError(error);
    }
  }

  async getFileBlob(
    workspaceId: string,
    projectId: string,
    entryId: string,
    options: TPpmVaultRequestOptions = {}
  ): Promise<Blob> {
    try {
      const response = await this.get(
        `${this.entryPath(workspaceId, projectId, entryId)}file/`,
        {},
        {
          responseType: "blob",
          signal: options.signal,
        }
      );
      return response.data as Blob;
    } catch (error) {
      throw await normalizeVaultRawError(error);
    }
  }

  /** Ссылка скачивания с настоящим именем файла (S: Content-Disposition: attachment; filename*=UTF-8''…). */
  downloadUrl(workspaceId: string, projectId: string, entryId: string) {
    return `${this.fileUrl(workspaceId, projectId, entryId)}?download=1`;
  }
  // ── /AF2.1 B5 ──

  pdfUrl(workspaceId: string, projectId: string, entryId: string) {
    return `${PPM_ASSET_API_BASE_URL}${this.entryPath(workspaceId, projectId, entryId)}pdf/`;
  }

  fileUrl(workspaceId: string, projectId: string, entryId: string) {
    return `${PPM_ASSET_API_BASE_URL}${this.entryPath(workspaceId, projectId, entryId)}file/`;
  }

  exportUrl(workspaceId: string, projectId: string) {
    return `${PPM_ASSET_API_BASE_URL}${this.vaultPath(workspaceId, projectId)}export/`;
  }

  private entryPath(workspaceId: string, projectId: string, entryId: string) {
    return `${this.vaultPath(workspaceId, projectId)}entries/${entryId}/`;
  }

  private vaultPath(workspaceId: string, projectId: string) {
    return `/api/ppm/v1/workspaces/${workspaceId}/projects/${projectId}/vault/`;
  }
}

// AF2.1 B4 (round 1): a file over the server's hard limit (nginx/Django, ahead of our own PpmVaultConflict handling —
// see apps/api/plane/settings/common.py: FILE_SIZE_LIMIT/DATA_UPLOAD_MAX_MEMORY_SIZE) comes back as a bare 413, or a
// 400/413 with no parseable {error:{...}} body — client-side pre-check (PPM_VAULT_MAX_UPLOAD_BYTES) should prevent
// this in practice, but map it defensively so the notice stays the "file too large" wording instead of a generic one.
function normalizeVaultError(error: unknown) {
  if (error instanceof PpmVaultServiceError) return error;
  if (isAxiosError(error)) {
    const status = error.response?.status;
    const payload = error.response?.data as
      | { error?: { code?: string; message?: string; details?: Record<string, unknown> } }
      | undefined;
    const bodyEmpty = typeof payload !== "object" || payload === null || !payload.error?.code;
    if (status === 413 || (status === 400 && bodyEmpty)) {
      return new PpmVaultServiceError("Файл превышает допустимый размер.", {
        code: "VAULT_FILE_TOO_LARGE",
        status,
      });
    }
    return new PpmVaultServiceError(payload?.error?.message ?? "Не удалось выполнить действие с хранилищем.", {
      code: payload?.error?.code,
      details: payload?.error?.details,
      status,
    });
  }
  return new PpmVaultServiceError(error instanceof Error ? error.message : "Ошибка хранилища.");
}

/**
 * AF2.1 B5: ответы responseType "blob"/"text" приносят тело ошибки Blob'ом или строкой — сначала читаем JSON, иначе
 * код ошибки Хранилища (VAULT_INVALID_FILE_TYPE, VAULT_STORAGE_FAILED) потеряется, а 400 без разобранного тела
 * normalizeVaultError примет за слишком большой файл.
 */
export async function normalizeVaultRawError(error: unknown) {
  if (isAxiosError(error) && error.response) {
    const { data } = error.response;
    try {
      const text = data instanceof Blob ? await data.text() : typeof data === "string" ? data : undefined;
      if (text !== undefined) error.response.data = JSON.parse(text);
    } catch {
      // Не JSON: останется общий текст ошибки.
    }
  }
  return normalizeVaultError(error);
}
