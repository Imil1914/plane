import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Dialog } from "@headlessui/react";
import {
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Download,
  FileImage,
  FileInput,
  FileOutput,
  FileText,
  FileUp,
  Folder,
  FolderOpen,
  History,
  Link2,
  LoaderCircle,
  Network,
  Pencil,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { PageHead } from "@/components/core/page-title";
import { usePpmConfirm } from "@/components/ppm-shell/use-ppm-confirm";
import { handlePpmDialogKeyDown, shouldDismissPpmDialog } from "@/helpers/ppm-dialog-dismiss.helper";
import { flattenVaultTree, getVaultTreeKeyAction } from "@/helpers/ppm-vault-tree.helper";
import { useProject } from "@/hooks/store/use-project";
import { useWorkspace } from "@/hooks/store/use-workspace";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import {
  PpmVaultService,
  PpmVaultServiceError,
  type TPpmVault,
  type TPpmVaultBacklinks,
  type TPpmVaultEntry,
  type TPpmVaultGraph,
  type TPpmVaultIndexPolicy,
  type TPpmVaultProjectPage,
  type TPpmVaultTransfer,
  type TPpmVaultVersion,
} from "@/services/ppm-vault.service";

type TPpmVaultRouteProps = {
  projectId: string;
  workspaceSlug: string;
};

type TVaultDialog = "folder" | "markdown" | "organize" | "import";
type TVaultView = "materials" | "connections" | "trash";

const INDEX_POLICY_LABELS: Record<TPpmVaultIndexPolicy, string> = {
  inherit: "Как у родительской папки",
  include: "Индексировать в Мозге проекта",
  exclude: "Не индексировать",
};

const VAULT_VIEWS: { value: TVaultView; label: string; icon: typeof FolderOpen }[] = [
  { value: "materials", label: "Материалы", icon: FolderOpen },
  { value: "connections", label: "Связи", icon: Network },
  { value: "trash", label: "Корзина", icon: Trash2 },
];
const VAULT_PANEL_ID = "ppm-vault-panel";
const vaultTabId = (view: TVaultView) => `ppm-vault-tab-${view}`;

export function PpmVaultRoute({ projectId, workspaceSlug }: TPpmVaultRouteProps) {
  const searchParams = useSearchParams();
  const { getPartialProjectById } = useProject();
  const { getWorkspaceBySlug } = useWorkspace();
  const project = getPartialProjectById(projectId);
  const workspace = getWorkspaceBySlug(workspaceSlug);
  const service = useMemo(() => new PpmVaultService(), []);
  const ppmT = usePpmTranslation();
  const { confirm, confirmDialog } = usePpmConfirm();
  const [vault, setVault] = useState<TPpmVault>();
  const [selectedId, setSelectedId] = useState<string>();
  const [view, setView] = useState<TVaultView>("materials");
  const [markdownContent, setMarkdownContent] = useState("");
  const [markdownVersion, setMarkdownVersion] = useState(0);
  const [backlinks, setBacklinks] = useState<TPpmVaultBacklinks>();
  const [versions, setVersions] = useState<TPpmVaultVersion[]>([]);
  const [transfers, setTransfers] = useState<TPpmVaultTransfer[]>([]);
  const [graph, setGraph] = useState<TPpmVaultGraph>();
  const [trash, setTrash] = useState<TPpmVaultEntry[]>([]);
  const [projectPages, setProjectPages] = useState<TPpmVaultProjectPage[]>([]);
  const [dialog, setDialog] = useState<TVaultDialog>();
  const [dialogName, setDialogName] = useState("");
  const [dialogParentId, setDialogParentId] = useState("");
  const [dialogPageId, setDialogPageId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const loadVault = useCallback(async () => {
    if (!workspace) return;
    setLoading(true);
    try {
      const response = await service.getVault(workspace.id, projectId);
      setVault(response);
      const requestedEntry = searchParams.get("entry_id");
      const allEntries = flattenEntries(response.entries);
      setSelectedId((current) => {
        if (requestedEntry && allEntries.some((entry) => entry.id === requestedEntry)) return requestedEntry;
        if (current && allEntries.some((entry) => entry.id === current)) return current;
        return response.entries[0]?.id;
      });
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось открыть хранилище.");
    } finally {
      setLoading(false);
    }
  }, [projectId, searchParams, service, workspace]);

  useEffect(() => {
    void loadVault();
  }, [loadVault]);

  const entries = useMemo(() => flattenEntries(vault?.entries ?? []), [vault]);
  const selected = useMemo(() => entries.find((entry) => entry.id === selectedId), [entries, selectedId]);
  const selectedFolderId = selected?.kind === "folder" ? selected.id : (selected?.parent_id ?? undefined);
  const canEdit = vault?.access === "edit";
  const blockedFolderIds = useMemo(
    () =>
      new Set(
        selected?.kind === "folder" ? [selected.id, ...flattenEntries(selected.children ?? []).map(({ id }) => id)] : []
      ),
    [selected]
  );
  const folderOptions = useMemo(
    () => entries.filter((entry) => entry.kind === "folder" && !blockedFolderIds.has(entry.id)),
    [blockedFolderIds, entries]
  );

  useEffect(() => {
    if (!workspace || !selected) {
      setMarkdownContent("");
      setMarkdownVersion(0);
      setBacklinks(undefined);
      setVersions([]);
      setTransfers([]);
      return;
    }
    let active = true;
    const requests: Promise<void>[] = [
      service.getBacklinks(workspace.id, projectId, selected.id).then((response) => {
        if (active) setBacklinks(response);
        return undefined;
      }),
      service.getTransfers(workspace.id, projectId, selected.id).then((response) => {
        if (active) setTransfers(response.transfers);
        return undefined;
      }),
    ];
    if (selected.kind === "markdown") {
      requests.push(
        service.getMarkdown(workspace.id, projectId, selected.id).then((response) => {
          if (!active) return;
          setMarkdownContent(response.content);
          setMarkdownVersion(response.entry.version);
          return undefined;
        })
      );
    } else {
      setMarkdownContent("");
      setMarkdownVersion(0);
    }
    if (selected.kind !== "folder") {
      requests.push(
        service.getVersions(workspace.id, projectId, selected.id).then((response) => {
          if (active) setVersions(response.versions);
          return undefined;
        })
      );
    } else {
      setVersions([]);
    }
    Promise.all(requests).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : "Не удалось загрузить сведения о материале.");
    });
    return () => {
      active = false;
    };
  }, [projectId, selected, service, workspace]);

  useEffect(() => {
    if (!workspace || view !== "connections") return;
    service
      .getGraph(workspace.id, projectId)
      .then(setGraph)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Не удалось построить карту связей."));
  }, [projectId, service, view, workspace]);

  const loadTrash = useCallback(async () => {
    if (!workspace || !canEdit) return;
    try {
      const response = await service.getTrash(workspace.id, projectId);
      setTrash(response.entries);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось открыть корзину.");
    }
  }, [canEdit, projectId, service, workspace]);

  useEffect(() => {
    if (view === "trash") void loadTrash();
  }, [loadTrash, view]);

  const openDialog = async (nextDialog: TVaultDialog) => {
    if (!vault) return;
    setDialog(nextDialog);
    setDialogName(nextDialog === "organize" ? (selected?.name ?? "") : "");
    setDialogParentId(selectedFolderId ?? vault.root_entry_id);
    setDialogPageId("");
    setError(undefined);
    if (nextDialog === "import" && workspace) {
      try {
        const response = await service.getTransferPages(workspace.id, projectId);
        setProjectPages(response.pages);
        setDialogPageId(response.pages[0]?.id ?? "");
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Не удалось получить Ворд-документы проекта.");
      }
    }
  };

  const submitDialog = async (event: FormEvent) => {
    event.preventDefault();
    if (!workspace || !vault || !dialog) return;
    setSaving(true);
    try {
      let entry: TPpmVaultEntry | undefined;
      const parentId = dialogParentId === vault.root_entry_id ? undefined : dialogParentId;
      if (dialog === "folder" && dialogName.trim()) {
        entry = await service.createFolder(workspace.id, projectId, dialogName.trim(), parentId);
      }
      if (dialog === "markdown" && dialogName.trim()) {
        entry = await service.createMarkdown(workspace.id, projectId, dialogName.trim(), parentId);
      }
      if (dialog === "organize" && selected && dialogName.trim()) {
        entry = await service.updateEntry(workspace.id, projectId, selected.id, {
          name: dialogName.trim(),
          parent_id: parentId ?? null,
        });
      }
      if (dialog === "import" && dialogPageId) {
        const response = await service.importPage(workspace.id, projectId, dialogPageId, parentId);
        entry = response.entry;
        setNotice("Ворд-документ импортирован как Markdown с записью происхождения.");
      }
      setDialog(undefined);
      await loadVault();
      if (entry) setSelectedId(entry.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось выполнить действие.");
    } finally {
      setSaving(false);
    }
  };

  const uploadFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!workspace || !file) return;
    setSaving(true);
    try {
      const entry = await service.uploadFile(workspace.id, projectId, file, selectedFolderId);
      await loadVault();
      setSelectedId(entry.id);
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось загрузить файл.");
    } finally {
      setSaving(false);
    }
  };

  const saveMarkdown = async () => {
    if (!workspace || selected?.kind !== "markdown") return;
    setSaving(true);
    try {
      const entry = await service.saveMarkdown(workspace.id, projectId, selected.id, markdownVersion, markdownContent);
      setMarkdownVersion(entry.version);
      await loadVault();
      setSelectedId(entry.id);
      setNotice("Новая версия Markdown сохранена.");
      setError(undefined);
    } catch (reason) {
      if (reason instanceof PpmVaultServiceError && reason.code === "VAULT_VERSION_CONFLICT") {
        setError("Файл уже изменён другим участником. Обновите страницу и объедините изменения.");
      } else {
        setError(reason instanceof Error ? reason.message : "Не удалось сохранить Markdown.");
      }
    } finally {
      setSaving(false);
    }
  };

  const changeIndexPolicy = async (indexPolicy: TPpmVaultIndexPolicy) => {
    if (!workspace || !selected) return;
    try {
      await service.setIndexPolicy(workspace.id, projectId, selected.id, indexPolicy);
      await loadVault();
      setSelectedId(selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось изменить индексацию.");
    }
  };

  const trashSelected = async () => {
    if (!workspace || !selected) return;
    const confirmed = await confirm({
      title: ppmT("vault.confirm_trash_title"),
      content: ppmT("vault.confirm_trash_description").replace("{name}", selected.name),
      confirmLabel: ppmT("vault.confirm_trash_action"),
      variant: "danger",
    });
    if (!confirmed) return;
    setSaving(true);
    try {
      await service.trashEntry(workspace.id, projectId, selected.id);
      setSelectedId(undefined);
      await loadVault();
      setNotice("Материал перемещён в корзину. Его можно восстановить.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось переместить материал в корзину.");
    } finally {
      setSaving(false);
    }
  };

  const restoreTrashEntry = async (entry: TPpmVaultEntry) => {
    if (!workspace) return;
    setSaving(true);
    try {
      const restored = await service.restoreEntry(workspace.id, projectId, entry.id);
      await Promise.all([loadVault(), loadTrash()]);
      setView("materials");
      setSelectedId(restored.id);
      setNotice("Материал восстановлен из корзины.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось восстановить материал.");
    } finally {
      setSaving(false);
    }
  };

  const restoreVersion = async (version: number) => {
    if (!workspace || !selected) return;
    const confirmed = await confirm({
      title: ppmT("vault.confirm_restore_version_title").replace("{version}", String(version)),
      content: ppmT("vault.confirm_restore_version_description"),
      confirmLabel: ppmT("vault.confirm_restore_version_action"),
      variant: "primary",
    });
    if (!confirmed) return;
    setSaving(true);
    try {
      const restored = await service.restoreVersion(workspace.id, projectId, selected.id, version, selected.version);
      await loadVault();
      setSelectedId(restored.id);
      setNotice(`Версия ${version} восстановлена как версия ${restored.version}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось восстановить версию.");
    } finally {
      setSaving(false);
    }
  };

  const exportToPage = async () => {
    if (!workspace || selected?.kind !== "markdown") return;
    setSaving(true);
    try {
      const response = await service.exportMarkdownToPage(workspace.id, projectId, selected.id);
      const history = await service.getTransfers(workspace.id, projectId, selected.id);
      setTransfers(history.transfers);
      setNotice(`Создан Ворд-документ «${response.page.name}». Связь с исходной версией сохранена.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось создать Ворд-документ.");
    } finally {
      setSaving(false);
    }
  };

  const visibleViews = VAULT_VIEWS.filter((item) => item.value !== "trash" || canEdit);

  // Tabs follow automatic activation: arrows, Home and End move focus and switch the section.
  const onTabsKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const count = visibleViews.length;
    const index = visibleViews.findIndex((item) => item.value === view);
    const nextIndex =
      event.code === "ArrowRight"
        ? (index + 1) % count
        : event.code === "ArrowLeft"
          ? (index - 1 + count) % count
          : event.code === "Home"
            ? 0
            : event.code === "End"
              ? count - 1
              : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const next = visibleViews[nextIndex].value;
    setView(next);
    document.getElementById(vaultTabId(next))?.focus();
  };

  if (!workspace || loading) return <VaultState text="Открываем хранилище проекта…" />;
  if (!vault) return <VaultState text={error ?? "Хранилище недоступно."} />;

  return (
    <>
      <PageHead title={`${project?.name ?? "PPM"} — Хранилище`} />
      <main className="flex h-full min-h-0 flex-col bg-surface-1" aria-label="Хранилище">
        <header className="border-b border-subtle px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-11 font-semibold tracking-[0.12em] text-accent-primary uppercase">Материалы проекта</p>
              <h1 className="mt-1 text-20 font-semibold text-primary">Хранилище</h1>
              <p className="mt-1 text-12 text-secondary">
                Документы, файлы, связи и история изменений команды в одном закрытом разделе.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <a
                className="inline-flex items-center gap-1.5 rounded-md border border-subtle bg-surface-2 px-3 py-2 text-12 font-semibold text-primary hover:bg-layer-1-hover"
                href={service.exportUrl(workspace.id, projectId)}
              >
                <Download className="size-4" aria-hidden="true" /> Скачать ZIP
              </a>
              {canEdit ? (
                <>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-md border border-subtle bg-surface-2 px-3 py-2 text-12 font-semibold text-primary hover:bg-layer-1-hover"
                    onClick={() => void openDialog("import")}
                  >
                    <FileInput className="size-4" aria-hidden="true" /> Из Ворд-документов
                  </button>
                  <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-accent-primary px-3 py-2 text-12 font-semibold text-on-accent hover:bg-accent-primary-hover">
                    <FileUp className="size-4" aria-hidden="true" /> Загрузить файл
                    <input
                      className="sr-only"
                      type="file"
                      accept=".md,.pdf,.png,.jpg,.jpeg,.webp,.txt,.csv,.json,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.key,.odt,.ods,.odp"
                      onChange={uploadFile}
                    />
                  </label>
                </>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-subtle px-2.5 py-1 text-11 font-semibold text-secondary">
                  <ShieldCheck className="size-3.5" aria-hidden="true" /> Только чтение
                </span>
              )}
            </div>
          </div>
          <div
            className="mt-4 flex flex-wrap gap-1"
            role="tablist"
            aria-label="Разделы хранилища"
            onKeyDown={onTabsKeyDown}
          >
            {visibleViews.map((item) => (
              <ViewButton
                active={view === item.value}
                icon={item.icon}
                key={item.value}
                value={item.value}
                onClick={() => setView(item.value)}
              >
                {item.label}
              </ViewButton>
            ))}
          </div>
        </header>

        {(error || notice) && (
          <div
            className={`mx-5 mt-4 flex items-center justify-between rounded-lg border px-3 py-2 text-12 ${
              error
                ? "border-danger-subtle bg-danger-subtle text-danger-primary"
                : "border-success-subtle bg-success-subtle text-success-primary"
            }`}
            role={error ? "alert" : "status"}
          >
            <span>{error ?? notice}</span>
            <button
              type="button"
              aria-label="Закрыть сообщение"
              onClick={() => {
                setError(undefined);
                setNotice(undefined);
              }}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        )}

        <div
          className="flex min-h-0 flex-1 flex-col"
          role="tabpanel"
          id={VAULT_PANEL_ID}
          aria-labelledby={vaultTabId(view)}
        >
          {view === "materials" && (
            <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,40%)_minmax(0,1fr)] md:grid-cols-[minmax(230px,300px)_minmax(0,1fr)] md:grid-rows-1">
              <aside className="overflow-y-auto border-b border-subtle bg-surface-2 p-3 md:border-r md:border-b-0">
                <div className="mb-3 flex items-center justify-between gap-2 px-2">
                  <span className="inline-flex items-center gap-2 text-11 font-semibold text-secondary uppercase">
                    <FolderOpen className="size-4" aria-hidden="true" /> Материалы проекта
                  </span>
                  {canEdit && (
                    <div className="flex gap-1">
                      <button
                        type="button"
                        className="rounded p-1 text-secondary hover:bg-layer-1-hover hover:text-primary"
                        title="Новая папка"
                        onClick={() => void openDialog("folder")}
                      >
                        <Folder className="size-4" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="rounded p-1 text-secondary hover:bg-layer-1-hover hover:text-primary"
                        title="Новый Markdown"
                        onClick={() => void openDialog("markdown")}
                      >
                        <FileText className="size-4" aria-hidden="true" />
                      </button>
                    </div>
                  )}
                </div>
                {vault.entries.length > 0 ? (
                  <VaultTree entries={vault.entries} selectedId={selectedId} onSelect={setSelectedId} />
                ) : (
                  <div className="rounded-lg border border-dashed border-subtle px-3 py-8 text-center text-12 text-tertiary">
                    Пока пусто. Создайте папку, Markdown или загрузите файл.
                  </div>
                )}
              </aside>

              <section className="min-w-0 overflow-y-auto p-5 sm:p-7">
                {selected ? (
                  <>
                    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-subtle pb-4">
                      <div className="min-w-0">
                        <p className="text-11 font-semibold text-accent-primary uppercase">
                          {entryKindLabel(selected.kind)}
                        </p>
                        <h2 className="mt-1 truncate text-20 font-semibold text-primary">{selected.name}</h2>
                        <p className="mt-1 truncate text-11 text-tertiary">{selected.path}</p>
                        {selected.kind !== "folder" && (
                          <p className="mt-1 text-11 text-tertiary">
                            Версия {selected.kind === "markdown" ? markdownVersion : selected.version} ·{" "}
                            {formatBytes(selected.size_bytes)}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {canEdit && (
                          <>
                            <button
                              type="button"
                              className="inline-flex items-center gap-1.5 rounded-md border border-subtle bg-surface-2 px-3 py-2 text-12 font-semibold text-primary hover:bg-layer-1-hover"
                              onClick={() => void openDialog("organize")}
                            >
                              <Pencil className="size-3.5" aria-hidden="true" /> Переименовать или переместить
                            </button>
                            <button
                              type="button"
                              className="inline-flex items-center gap-1.5 rounded-md border border-danger-strong px-3 py-2 text-12 font-semibold text-danger-primary hover:bg-danger-subtle"
                              disabled={saving}
                              onClick={() => void trashSelected()}
                            >
                              <Trash2 className="size-3.5" aria-hidden="true" /> В корзину
                            </button>
                          </>
                        )}
                        {selected.kind !== "folder" && (
                          <Link
                            href={canvasProjectionHref(workspaceSlug, projectId, selected)}
                            className="rounded-md border border-subtle bg-surface-2 px-3 py-2 text-12 font-semibold text-primary hover:bg-layer-1-hover"
                          >
                            На холст «Мозг проекта»
                          </Link>
                        )}
                      </div>
                    </div>

                    {canEdit && (
                      <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-subtle bg-surface-2 p-3">
                        <label className="flex items-center gap-2 text-12 text-secondary">
                          Индексация
                          <select
                            aria-label="Политика индексации"
                            className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-12 text-primary"
                            value={selected.index_policy}
                            onChange={(event) => void changeIndexPolicy(event.target.value as TPpmVaultIndexPolicy)}
                          >
                            {vault.index_policy_values.map((policy) => (
                              <option key={policy} value={policy}>
                                {INDEX_POLICY_LABELS[policy]}
                              </option>
                            ))}
                          </select>
                        </label>
                        {selected.kind === "markdown" && (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1.5 rounded-md border border-subtle px-2.5 py-1.5 text-12 font-semibold text-primary hover:bg-layer-1-hover"
                            disabled={saving}
                            onClick={() => void exportToPage()}
                          >
                            <FileOutput className="size-3.5" aria-hidden="true" /> Создать Ворд-документ
                          </button>
                        )}
                      </div>
                    )}

                    <EntryContent
                      canEdit={canEdit}
                      entry={selected}
                      markdownContent={markdownContent}
                      projectId={projectId}
                      saving={saving}
                      service={service}
                      workspaceId={workspace.id}
                      onChangeMarkdown={setMarkdownContent}
                      onSaveMarkdown={saveMarkdown}
                    />

                    <div className="mt-6 grid gap-4 xl:grid-cols-3">
                      <ConnectionsCard backlinks={backlinks} onSelect={setSelectedId} />
                      <VersionsCard
                        canEdit={canEdit}
                        entry={selected}
                        saving={saving}
                        versions={versions}
                        onRestore={restoreVersion}
                      />
                      <TransfersCard transfers={transfers} />
                    </div>
                  </>
                ) : (
                  <VaultEmptyState icon={FolderOpen} text="Выберите материал слева." />
                )}
              </section>
            </div>
          )}

          {view === "connections" && (
            <ConnectionMap
              graph={graph}
              onOpen={(entryId) => {
                setSelectedId(entryId);
                setView("materials");
              }}
            />
          )}

          {view === "trash" && canEdit && <TrashView entries={trash} saving={saving} onRestore={restoreTrashEntry} />}
        </div>
      </main>

      {dialog && (
        <VaultDialog
          dialog={dialog}
          dialogName={dialogName}
          dialogPageId={dialogPageId}
          dialogParentId={dialogParentId}
          folderOptions={folderOptions}
          projectPages={projectPages}
          rootEntryId={vault.root_entry_id}
          saving={saving}
          onClose={() => setDialog(undefined)}
          onNameChange={setDialogName}
          onPageChange={setDialogPageId}
          onParentChange={setDialogParentId}
          onSubmit={submitDialog}
        />
      )}
      {confirmDialog}
    </>
  );
}

function EntryContent({
  canEdit,
  entry,
  markdownContent,
  onChangeMarkdown,
  onSaveMarkdown,
  projectId,
  saving,
  service,
  workspaceId,
}: {
  canEdit: boolean;
  entry: TPpmVaultEntry;
  markdownContent: string;
  onChangeMarkdown: (value: string) => void;
  onSaveMarkdown: () => void;
  projectId: string;
  saving: boolean;
  service: PpmVaultService;
  workspaceId: string;
}) {
  if (entry.kind === "folder") {
    return <VaultEmptyState icon={Folder} text="Папка выбрана. Новые материалы будут созданы внутри неё." />;
  }
  if (entry.kind === "markdown") {
    return (
      <div className="mt-5 grid gap-4 xl:grid-cols-2">
        <div>
          <label className="mb-2 block text-12 font-semibold text-secondary" htmlFor="ppm-vault-markdown-editor">
            Markdown
          </label>
          <textarea
            id="ppm-vault-markdown-editor"
            aria-label="Редактор Markdown"
            className="min-h-[420px] w-full resize-y rounded-lg border border-subtle bg-surface-2 p-4 font-code text-13 leading-6 text-primary outline-none focus:border-accent-strong"
            readOnly={!canEdit}
            value={markdownContent}
            onChange={(event) => onChangeMarkdown(event.target.value)}
          />
          {canEdit && (
            <button
              type="button"
              className="mt-3 rounded-md bg-accent-primary px-3 py-2 text-12 font-semibold text-on-accent disabled:opacity-60"
              disabled={saving}
              onClick={onSaveMarkdown}
            >
              Сохранить новую версию
            </button>
          )}
        </div>
        <div>
          <p className="mb-2 text-12 font-semibold text-secondary">Предпросмотр</p>
          <pre className="min-h-[420px] rounded-lg border border-subtle bg-layer-1 p-4 text-13 leading-6 whitespace-pre-wrap text-primary">
            {markdownContent || "Пустой документ"}
          </pre>
        </div>
      </div>
    );
  }
  if (entry.kind === "pdf") {
    return (
      <iframe
        className="mt-5 h-[min(70vh,760px)] w-full rounded-lg border border-subtle bg-white"
        sandbox="allow-same-origin"
        src={service.pdfUrl(workspaceId, projectId, entry.id)}
        title={`Предпросмотр PDF: ${entry.name}`}
      />
    );
  }
  if (entry.kind === "image") {
    return (
      <div className="mt-5 grid min-h-72 place-items-center rounded-lg border border-subtle bg-layer-1 p-4">
        <img
          alt={entry.name}
          className="max-h-[min(70vh,760px)] max-w-full rounded-md object-contain"
          loading="lazy"
          referrerPolicy="no-referrer"
          src={service.fileUrl(workspaceId, projectId, entry.id)}
        />
      </div>
    );
  }
  return (
    <div className="mt-5 grid min-h-72 place-items-center rounded-lg border border-subtle bg-layer-1 p-6 text-center">
      <div>
        <FileText className="mx-auto size-10 text-accent-primary" aria-hidden="true" />
        <p className="mt-3 text-14 font-semibold text-primary">Файл хранится в проекте</p>
        <p className="mt-1 text-12 text-secondary">
          Просмотр выполняется во внешнем приложении без исполнения содержимого в PPM.
        </p>
        <a
          className="mt-4 inline-flex rounded-md bg-accent-primary px-3 py-2 text-12 font-semibold text-on-accent"
          href={service.fileUrl(workspaceId, projectId, entry.id)}
        >
          Скачать файл
        </a>
      </div>
    </div>
  );
}

function ConnectionsCard({
  backlinks,
  onSelect,
}: {
  backlinks?: TPpmVaultBacklinks;
  onSelect: (entryId: string) => void;
}) {
  return (
    <section className="rounded-lg border border-subtle bg-surface-2 p-4">
      <h3 className="flex items-center gap-2 text-13 font-semibold text-primary">
        <Link2 className="size-4 text-accent-primary" aria-hidden="true" /> Связи документа
      </h3>
      <p className="mt-1 text-12 text-tertiary">
        Ссылки вида [[Название]] обновляются при переименовании и перемещении.
      </p>
      <div className="mt-4 space-y-4 text-12">
        <LinkGroup
          empty="На этот материал пока никто не ссылается."
          label="Ссылаются сюда"
          links={(backlinks?.incoming ?? []).map((link) => ({
            entryId: link.source_entry.id,
            key: link.id,
            label: link.source_entry.path,
            status: "resolved",
          }))}
          onSelect={onSelect}
        />
        <LinkGroup
          empty="В этом материале нет wiki-ссылок."
          label="Ссылки отсюда"
          links={(backlinks?.outgoing ?? []).map((link) => ({
            entryId: link.target_entry?.id,
            key: link.id,
            label: link.target_entry?.path ?? link.raw_target,
            status: link.status,
          }))}
          onSelect={onSelect}
        />
      </div>
    </section>
  );
}

function LinkGroup({
  empty,
  label,
  links,
  onSelect,
}: {
  empty: string;
  label: string;
  links: { entryId?: string; key: string; label: string; status: string }[];
  onSelect: (entryId: string) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-12 font-semibold text-secondary">{label}</p>
      {links.length > 0 ? (
        <ul className="space-y-1.5">
          {links.map((link) => (
            <li key={link.key}>
              <button
                type="button"
                className="w-full rounded-md border border-subtle px-2.5 py-2 text-left text-secondary hover:bg-layer-1-hover hover:text-primary disabled:cursor-default disabled:opacity-70"
                disabled={!link.entryId}
                onClick={() => link.entryId && onSelect(link.entryId)}
              >
                <span className="block truncate">{link.label}</span>
                {link.status !== "resolved" && (
                  <span className="mt-0.5 block text-11 text-warning-primary">
                    {link.status === "ambiguous" ? "Найдено несколько совпадений" : "Материал не найден"}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-12 text-tertiary">{empty}</p>
      )}
    </div>
  );
}

function VersionsCard({
  canEdit,
  entry,
  onRestore,
  saving,
  versions,
}: {
  canEdit: boolean;
  entry: TPpmVaultEntry;
  onRestore: (version: number) => void;
  saving: boolean;
  versions: TPpmVaultVersion[];
}) {
  return (
    <section className="rounded-lg border border-subtle bg-surface-2 p-4">
      <h3 className="flex items-center gap-2 text-13 font-semibold text-primary">
        <History className="size-4 text-accent-primary" aria-hidden="true" /> История версий
      </h3>
      <p className="mt-1 text-12 text-tertiary">Восстановление всегда создаёт новую версию и не стирает историю.</p>
      {entry.kind === "folder" ? (
        <p className="mt-4 text-12 text-tertiary">У папки нет содержимого и версий.</p>
      ) : versions.length > 0 ? (
        <ul className="mt-4 max-h-64 space-y-2 overflow-y-auto">
          {versions.map((version) => (
            <li
              className="flex items-center justify-between gap-3 rounded-md border border-subtle px-2.5 py-2"
              key={version.version}
            >
              <div>
                <p className="text-12 font-semibold text-primary">
                  Версия {version.version} {version.current && <span className="text-accent-primary">· текущая</span>}
                </p>
                <p className="mt-0.5 text-11 text-tertiary">
                  {formatDate(version.created_at)} · {formatBytes(version.size_bytes)}
                </p>
              </div>
              {canEdit && !version.current && (
                <button
                  type="button"
                  className="rounded-md border border-subtle px-2 py-1 text-12 font-semibold text-secondary hover:bg-layer-1-hover hover:text-primary"
                  disabled={saving}
                  onClick={() => onRestore(version.version)}
                >
                  Восстановить
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-12 text-tertiary">История пока пуста.</p>
      )}
    </section>
  );
}

function TransfersCard({ transfers }: { transfers: TPpmVaultTransfer[] }) {
  return (
    <section className="rounded-lg border border-subtle bg-surface-2 p-4">
      <h3 className="flex items-center gap-2 text-13 font-semibold text-primary">
        <FileInput className="size-4 text-accent-primary" aria-hidden="true" /> Обмен с Ворд-документами
      </h3>
      <p className="mt-1 text-12 text-tertiary">
        PPM сохраняет, какая версия и когда была импортирована или экспортирована.
      </p>
      {transfers.length > 0 ? (
        <ul className="mt-4 max-h-64 space-y-2 overflow-y-auto">
          {transfers.map((transfer) => (
            <li className="rounded-md border border-subtle px-2.5 py-2" key={transfer.id}>
              <p className="text-12 font-semibold text-primary">
                {transfer.direction === "page_to_vault" ? "Импорт из Ворд-документа" : "Создан Ворд-документ"}
              </p>
              <p className="mt-0.5 text-11 text-tertiary">
                Версия материала {transfer.entry_version} · {formatDate(transfer.created_at)}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-12 text-tertiary">Обмена с Ворд-документами ещё не было.</p>
      )}
    </section>
  );
}

function ConnectionMap({ graph, onOpen }: { graph?: TPpmVaultGraph; onOpen: (entryId: string) => void }) {
  if (!graph) return <VaultState text="Строим карту связей…" />;
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  return (
    <section className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-7">
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-11 font-semibold tracking-[0.12em] text-accent-primary uppercase">Карта знаний</p>
            <h2 className="mt-1 text-20 font-semibold text-primary">Связи материалов</h2>
            <p className="mt-1 text-12 text-secondary">
              Нажмите на материал, чтобы открыть его. Неразрешённые ссылки отмечены отдельно.
            </p>
          </div>
          <p className="rounded-full border border-subtle px-3 py-1 text-11 text-secondary">
            {graph.nodes.length} материалов · {graph.edges.length} связей
          </p>
        </div>
        <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.7fr)]">
          <div className="grid content-start gap-2 sm:grid-cols-2">
            {graph.nodes.map((node) => {
              const incoming = graph.edges.filter((edge) => edge.target_entry_id === node.id).length;
              const outgoing = graph.edges.filter((edge) => edge.source_entry_id === node.id).length;
              return (
                <button
                  type="button"
                  className="rounded-lg border border-subtle bg-surface-2 p-4 text-left hover:border-accent-strong hover:bg-layer-1-hover"
                  key={node.id}
                  onClick={() => onOpen(node.id)}
                >
                  <p className="truncate text-13 font-semibold text-primary">{node.name}</p>
                  <p className="mt-1 truncate text-11 text-tertiary">{node.path}</p>
                  <p className="mt-3 text-12 text-secondary">
                    ← {incoming} · → {outgoing}
                  </p>
                </button>
              );
            })}
          </div>
          <div className="rounded-lg border border-subtle bg-surface-2 p-4">
            <h3 className="text-13 font-semibold text-primary">Все переходы</h3>
            {graph.edges.length > 0 ? (
              <ul className="mt-3 max-h-[60vh] space-y-2 overflow-y-auto">
                {graph.edges.map((edge) => (
                  <li className="rounded-md border border-subtle p-2.5 text-12" key={edge.id}>
                    <span className="text-primary">{nodeById.get(edge.source_entry_id)?.name ?? "Материал"}</span>
                    <span className="mx-2 text-tertiary">→</span>
                    <span className={edge.status === "resolved" ? "text-primary" : "text-warning-primary"}>
                      {nodeById.get(edge.target_entry_id ?? "")?.name ?? edge.raw_target}
                    </span>
                    {edge.status !== "resolved" && (
                      <p className="mt-1 text-11 text-warning-primary">
                        {edge.status === "ambiguous" ? "Несколько совпадений" : "Материал не найден"}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-12 text-tertiary">
                Добавьте в Markdown ссылку [[Название материала]], чтобы появилась связь.
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function TrashView({
  entries,
  onRestore,
  saving,
}: {
  entries: TPpmVaultEntry[];
  onRestore: (entry: TPpmVaultEntry) => void;
  saving: boolean;
}) {
  return (
    <section className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-7">
      <div className="mx-auto max-w-4xl">
        <p className="text-11 font-semibold tracking-[0.12em] text-accent-primary uppercase">Безопасное удаление</p>
        <h2 className="mt-1 text-20 font-semibold text-primary">Корзина</h2>
        <p className="mt-1 text-12 text-secondary">
          Материалы не уничтожаются сразу и могут быть возвращены в исходную папку.
        </p>
        {entries.length > 0 ? (
          <ul className="mt-6 space-y-2">
            {entries.map((entry) => (
              <li
                className="flex items-center justify-between gap-4 rounded-lg border border-subtle bg-surface-2 p-4"
                key={entry.id}
              >
                <div className="min-w-0">
                  <p className="truncate text-13 font-semibold text-primary">{entry.name}</p>
                  <p className="mt-1 truncate text-11 text-tertiary">{entry.path}</p>
                </div>
                <button
                  type="button"
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-subtle px-3 py-2 text-12 font-semibold text-primary hover:bg-layer-1-hover"
                  disabled={saving}
                  onClick={() => onRestore(entry)}
                >
                  <ArchiveRestore className="size-4" aria-hidden="true" /> Восстановить
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <VaultEmptyState icon={Trash2} text="Корзина пуста." />
        )}
      </div>
    </section>
  );
}

// Initial focus for the first dialog field. Headless UI attaches its portal node only after the content
// commits, so React autoFocus fires on a detached element and focus falls to the close button. A microtask
// runs after the attach and before the dialog's own initial-focus pass, which keeps focus already inside.
function focusOnMount(node: HTMLElement | null) {
  if (node) queueMicrotask(() => node.focus());
}

function VaultDialog({
  dialog,
  dialogName,
  dialogPageId,
  dialogParentId,
  folderOptions,
  onClose,
  onNameChange,
  onPageChange,
  onParentChange,
  onSubmit,
  projectPages,
  rootEntryId,
  saving,
}: {
  dialog: TVaultDialog;
  dialogName: string;
  dialogPageId: string;
  dialogParentId: string;
  folderOptions: TPpmVaultEntry[];
  onClose: () => void;
  onNameChange: (value: string) => void;
  onPageChange: (value: string) => void;
  onParentChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  projectPages: TPpmVaultProjectPage[];
  rootEntryId: string;
  saving: boolean;
}) {
  const title =
    dialog === "folder"
      ? "Новая папка"
      : dialog === "markdown"
        ? "Новый Markdown"
        : dialog === "organize"
          ? "Переименовать или переместить"
          : "Импорт из Ворд-документов";
  const valid = dialog === "import" ? Boolean(dialogPageId) : Boolean(dialogName.trim());
  // Esc closes (not during a request); a backdrop click does not, so typed input survives a stray click.
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  return (
    <ModalCore
      isOpen
      handleClose={() => {
        if (shouldDismissPpmDialog({ reason: "backdrop", saving })) onClose();
        else lastFocusedRef.current?.focus();
      }}
      position={EModalPosition.CENTER}
      width={EModalWidth.MD}
    >
      <form
        className="p-5"
        onSubmit={onSubmit}
        onFocus={(event) => {
          lastFocusedRef.current = event.target;
        }}
        onKeyDown={(event) => handlePpmDialogKeyDown(event, { saving, onClose })}
      >
        <div className="flex items-center justify-between gap-3">
          <Dialog.Title as="h2" className="text-16 font-semibold text-primary">
            {title}
          </Dialog.Title>
          <button type="button" aria-label="Закрыть" onClick={onClose}>
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        {dialog === "import" ? (
          <>
            <label className="mt-5 block text-12 font-semibold text-secondary" htmlFor="ppm-vault-page">
              Ворд-документ проекта
            </label>
            <select
              id="ppm-vault-page"
              ref={focusOnMount}
              className="mt-2 w-full rounded-md border border-subtle bg-surface-2 px-3 py-2 text-13 text-primary outline-none focus:border-accent-strong"
              value={dialogPageId}
              onChange={(event) => onPageChange(event.target.value)}
            >
              {projectPages.length === 0 && <option value="">Нет доступных документов</option>}
              {projectPages.map((page) => (
                <option key={page.id} value={page.id}>
                  {page.name}
                </option>
              ))}
            </select>
            <p className="mt-2 text-12 text-tertiary">
              Будет создан отдельный Markdown. Исходный Ворд-документ не изменится.
            </p>
          </>
        ) : (
          <>
            <label className="mt-5 block text-12 font-semibold text-secondary" htmlFor="ppm-vault-entry-name">
              {dialog === "folder" ? "Название папки" : "Название материала"}
            </label>
            <input
              id="ppm-vault-entry-name"
              ref={focusOnMount}
              className="mt-2 w-full rounded-md border border-subtle bg-surface-2 px-3 py-2 text-13 text-primary outline-none focus:border-accent-strong"
              value={dialogName}
              onChange={(event) => onNameChange(event.target.value)}
            />
          </>
        )}
        <label className="mt-4 block text-12 font-semibold text-secondary" htmlFor="ppm-vault-parent">
          Папка назначения
        </label>
        <select
          id="ppm-vault-parent"
          className="mt-2 w-full rounded-md border border-subtle bg-surface-2 px-3 py-2 text-13 text-primary outline-none focus:border-accent-strong"
          value={dialogParentId || rootEntryId}
          onChange={(event) => onParentChange(event.target.value)}
        >
          <option value={rootEntryId}>Корень хранилища</option>
          {folderOptions.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.path}
            </option>
          ))}
        </select>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-subtle px-3 py-2 text-12 text-primary"
            onClick={onClose}
          >
            Отмена
          </button>
          <button
            type="submit"
            className="rounded-md bg-accent-primary px-3 py-2 text-12 font-semibold text-on-accent disabled:opacity-60"
            disabled={!valid || saving}
          >
            {dialog === "import" ? "Импортировать" : dialog === "organize" ? "Сохранить" : "Создать"}
          </button>
        </div>
      </form>
    </ModalCore>
  );
}

function ViewButton({
  active,
  children,
  icon: Icon,
  onClick,
  value,
}: {
  active: boolean;
  children: string;
  icon: typeof FolderOpen;
  onClick: () => void;
  value: TVaultView;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={vaultTabId(value)}
      aria-selected={active}
      aria-controls={VAULT_PANEL_ID}
      tabIndex={active ? 0 : -1}
      className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-12 font-semibold text-secondary hover:bg-layer-1-hover hover:text-primary data-[active=true]:bg-layer-1-selected data-[active=true]:text-primary"
      data-active={active}
      onClick={onClick}
    >
      <Icon className="size-4" aria-hidden="true" /> {children}
    </button>
  );
}

// Flat treeitems with aria-level and a roving tabindex. Arrows move focus only; Enter/Space or a click
// selects, because selecting loads content, versions and backlinks. Folders start expanded.
function VaultTree({
  entries,
  onSelect,
  selectedId,
}: {
  entries: TPpmVaultEntry[];
  onSelect: (entryId: string) => void;
  selectedId?: string;
}) {
  const ppmT = usePpmTranslation();
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [activeId, setActiveId] = useState(selectedId);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const allRows = useMemo(
    () => flattenVaultTree(entries, new Set(flattenEntries(entries).map(({ id }) => id))),
    [entries]
  );
  const parentById = useMemo(() => new Map(allRows.map((row) => [row.id, row.parentId])), [allRows]);
  const rows = useMemo(
    () =>
      flattenVaultTree(
        entries,
        new Set(allRows.filter((row) => row.hasChildren && !collapsedIds.has(row.id)).map((row) => row.id))
      ),
    [allRows, collapsedIds, entries]
  );

  // A selection made elsewhere (backlinks, connection map, reload) becomes the tab stop and is revealed.
  useEffect(() => {
    if (!selectedId) return;
    setActiveId(selectedId);
    setCollapsedIds((current) => {
      const next = new Set(current);
      for (let id = parentById.get(selectedId); id; id = parentById.get(id)) next.delete(id);
      return next.size === current.size ? current : next;
    });
  }, [parentById, selectedId]);

  // The tab stop falls back to the nearest visible ancestor, then to the first row.
  const visibleIds = new Set(rows.map((row) => row.id));
  let tabStopId = activeId;
  while (tabStopId && !visibleIds.has(tabStopId)) tabStopId = parentById.get(tabStopId);
  tabStopId ??= rows[0]?.id;

  const setExpanded = (entryId: string, expanded: boolean) =>
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (expanded) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  const focusRow = (entryId?: string) => {
    if (entryId) rowRefs.current.get(entryId)?.focus();
  };
  const onRowKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const row = rows[index];
    const action = getVaultTreeKeyAction(event.code, row);
    if (!action) return;
    event.preventDefault();
    if (action === "next") focusRow(rows[index + 1]?.id);
    else if (action === "prev") focusRow(rows[index - 1]?.id);
    else if (action === "first") focusRow(rows[0]?.id);
    else if (action === "last") focusRow(rows[rows.length - 1]?.id);
    else if (action === "parent") focusRow(row.parentId);
    else if (action === "expand" || action === "collapse") setExpanded(row.id, action === "expand");
    else onSelect(row.id);
  };

  return (
    <div className="space-y-1" role="tree" aria-label={ppmT("vault.tree_label")}>
      {rows.map((row, index) => {
        const { entry } = row;
        const Icon =
          entry.kind === "folder"
            ? Folder
            : entry.kind === "image"
              ? FileImage
              : entry.kind === "pdf"
                ? FileUp
                : FileText;
        const isSelected = selectedId === entry.id;
        return (
          <div
            key={entry.id}
            ref={(node) => {
              if (node) rowRefs.current.set(entry.id, node);
              else rowRefs.current.delete(entry.id);
            }}
            role="treeitem"
            aria-level={row.level}
            aria-selected={isSelected}
            aria-expanded={row.hasChildren ? row.expanded : undefined}
            tabIndex={entry.id === tabStopId ? 0 : -1}
            className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-left text-12 text-secondary hover:bg-layer-1-hover hover:text-primary data-[selected=true]:bg-layer-1-selected data-[selected=true]:font-semibold data-[selected=true]:text-primary"
            data-selected={isSelected}
            style={{ paddingLeft: `${8 + (row.level - 1) * 18}px` }}
            onClick={() => onSelect(entry.id)}
            onFocus={() => setActiveId(entry.id)}
            onKeyDown={(event) => onRowKeyDown(event, index)}
          >
            {row.hasChildren ? (
              // Mouse affordance only: keyboard users toggle with ArrowLeft/ArrowRight.
              <span
                aria-hidden="true"
                className="grid size-4 shrink-0 place-items-center rounded text-tertiary hover:text-primary"
                onClick={(event) => {
                  event.stopPropagation();
                  setExpanded(entry.id, !row.expanded);
                }}
              >
                {row.expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              </span>
            ) : (
              <span aria-hidden="true" className="size-4 shrink-0" />
            )}
            <Icon className="size-4 shrink-0 text-accent-primary" aria-hidden="true" />
            <span className="truncate">{entry.name}</span>
          </div>
        );
      })}
    </div>
  );
}

function VaultState({ text }: { text: string }) {
  return (
    <div className="grid h-full min-h-72 place-items-center bg-surface-1 p-8 text-center">
      <div>
        <LoaderCircle className="mx-auto size-6 animate-spin text-accent-primary" aria-hidden="true" />
        <p className="mt-3 text-13 text-secondary">{text}</p>
      </div>
    </div>
  );
}

function VaultEmptyState({ icon: Icon, text }: { icon: typeof Folder; text: string }) {
  return (
    <div className="grid min-h-72 place-items-center text-center text-secondary">
      <div>
        <Icon className="mx-auto size-10 text-accent-primary" aria-hidden="true" />
        <p className="mt-3 text-12">{text}</p>
      </div>
    </div>
  );
}

function flattenEntries(entries: TPpmVaultEntry[]): TPpmVaultEntry[] {
  return entries.flatMap((entry) => [entry, ...flattenEntries(entry.children ?? [])]);
}

function entryKindLabel(kind: TPpmVaultEntry["kind"]) {
  if (kind === "folder") return "Папка";
  if (kind === "pdf") return "PDF-документ";
  if (kind === "image") return "Изображение";
  if (kind === "file") return "Файл";
  return "Markdown-документ";
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} КБ`;
  return `${(value / (1024 * 1024)).toFixed(1)} МБ`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function canvasProjectionHref(workspaceSlug: string, projectId: string, entry: TPpmVaultEntry) {
  const parameters = new URLSearchParams({
    ppm_vault_entry: entry.id,
    ppm_vault_extension: entry.extension,
    ppm_vault_title: entry.name,
    ppm_vault_url: `/${workspaceSlug}/projects/${projectId}/knowledge?entry_id=${entry.id}`,
    ppm_vault_version: String(entry.version),
  });
  return `/${workspaceSlug}/projects/${projectId}/brain?${parameters.toString()}`;
}
