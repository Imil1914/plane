/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  Archive,
  ChevronDown,
  ChevronUp,
  Columns3,
  Copy,
  Download,
  ExternalLink,
  FileText,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  List,
  ListTodo,
  LoaderCircle,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  SquareCheck,
  Trash2,
} from "lucide-react";
import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  T,
  createShapeId,
  resizeBox,
  stopEventPropagation,
  useEditor,
  useValue,
  type Editor,
  type RecordProps,
  type TLArrowBinding,
  type TLArrowShape,
  type TLBaseShape,
  type TLResizeInfo,
} from "tldraw";
import {
  createPpmCanvasNode,
  createPpmOrchestratorCallNode,
  createPpmOrchestratorProjectionConnections,
  createPpmOrchestratorTaskNode,
  duplicatePpmCanvasNode,
  isSamePpmOrchestratorProjection,
  isPpmMermaidSourceSafe,
  parseSerializedPpmCanvasNode,
  serializePpmCanvasNode,
  updatePpmCanvasNode,
  type TPpmCanvasBinding,
  type TPpmCanvasContentBinding,
  type TPpmCanvasGitBinding,
  type TPpmCanvasNode,
  type TPpmCanvasOrchestratorProjectionRef,
  type TPpmCanvasOrchestratorTrace,
  type TPpmCanvasOwnedNode,
  type TPpmCanvasSearchNode,
  type TPpmCanvasServiceRunEnvelope,
  type TPpmCanvasWorkItemBinding,
  type TPpmWorkItemEditOptions,
  type TPpmWorkItemPatchRequest,
  type TPpmWorkItemProjection,
  type TPpmWorkItemViewCreateRequest,
  type TPpmWorkItemsViewQuery,
  type TPpmWorkItemsViewResponse,
} from "@ppm/canvas";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { getPpmStateDisplayName } from "@/lib/ppm-design";
import { useTranslation } from "@plane/i18n";
import type { TPpmTranslationKey } from "@ppm/brand";
import {
  fillCanvasTemplate,
  LIVE_SOURCE_LABEL_KEYS,
  LIVE_SOURCE_OPEN_KEYS,
  liveCardMeta,
  liveSourceForEntity,
  nodeIndicatorRadius,
  OWN_NODE_KIND_KEYS,
  sectionObjectCountKey,
  shouldNarrowTitle,
  usePpmCanvasGrammarV2,
} from "./canvas-grammar";
import { citationParts, isCitationStale, isExternalHref } from "./citation-format";
import { LiveOpenLink, LiveSourceHeader, OwnNodeGlyph } from "./live-card";

export const PPM_CANVAS_SHAPE_TYPE = "ppm-canvas-node" as const;

export type TPpmCanvasShape = TLBaseShape<
  typeof PPM_CANVAS_SHAPE_TYPE,
  {
    h: number;
    node: string;
    w: number;
  }
>;

const COLOR_CLASS: Record<TPpmCanvasNode["visual"]["color"], string> = {
  cyan: "ppm-canvas-node--cyan",
  green: "ppm-canvas-node--green",
  violet: "ppm-canvas-node--violet",
  yellow: "ppm-canvas-node--yellow",
};

export const PRIORITY_LABELS = {
  urgent: "canvas.priority_urgent",
  high: "canvas.priority_high",
  medium: "canvas.priority_medium",
  low: "canvas.priority_low",
  none: "canvas.priority_none",
} as const satisfies Record<TPpmCanvasWorkItemBinding["source"]["display"]["priority"], TPpmTranslationKey>;

function isContentProjectionBinding(binding?: TPpmCanvasBinding): binding is TPpmCanvasContentBinding {
  return Boolean(binding && ["page", "attachment", "vault_file"].includes(binding.entity_type));
}

type TPpmWorkItemProjectionContextValue = {
  bindingsByShapeId: ReadonlyMap<string, TPpmCanvasBinding | TPpmCanvasContentBinding>;
  canEdit: boolean;
  errorsByShapeId: ReadonlyMap<string, string>;
  isRefreshing: boolean;
  onRefresh: () => void;
  onCreateFromView: (request: TPpmWorkItemViewCreateRequest) => Promise<TPpmWorkItemProjection>;
  onExportView: (format: "csv" | "markdown", query: TPpmWorkItemsViewQuery) => Promise<void>;
  onLoadView: (query: TPpmWorkItemsViewQuery) => Promise<TPpmWorkItemsViewResponse>;
  onRemove: (shape: TPpmCanvasShape, binding: TPpmCanvasBinding | TPpmCanvasContentBinding) => void;
  onReplaceVaultFile: (shape: TPpmCanvasShape, binding: TPpmCanvasContentBinding, file: File) => void;
  onUpdate: (
    shapeId: string,
    binding: TPpmCanvasWorkItemBinding,
    patch: Omit<TPpmWorkItemPatchRequest, "source_version">
  ) => void;
  onUpdateSource: (
    source: TPpmWorkItemProjection,
    patch: Omit<TPpmWorkItemPatchRequest, "source_version">
  ) => Promise<TPpmWorkItemProjection>;
  options: TPpmWorkItemEditOptions;
  pendingWorkItemIds: ReadonlySet<string>;
};

type TPpmCanvasBoardNavigationContextValue = {
  onOpenBoard: (boardId: string) => void;
};

export const PpmCanvasBoardNavigationContext = createContext<TPpmCanvasBoardNavigationContextValue>({
  onOpenBoard: () => undefined,
});

export const PpmWorkItemProjectionContext = createContext<TPpmWorkItemProjectionContextValue>({
  bindingsByShapeId: new Map(),
  canEdit: false,
  errorsByShapeId: new Map(),
  isRefreshing: false,
  onRefresh: () => undefined,
  onCreateFromView: () => Promise.reject(new Error("Work items view is unavailable.")),
  onExportView: () => Promise.reject(new Error("Work items view export is unavailable.")),
  onLoadView: () => Promise.reject(new Error("Work items view is unavailable.")),
  onRemove: () => undefined,
  onReplaceVaultFile: () => undefined,
  onUpdate: () => undefined,
  onUpdateSource: () => Promise.reject(new Error("Work item update is unavailable.")),
  options: { assignees: [], priorities: [], states: [] },
  pendingWorkItemIds: new Set(),
});

export class PpmCanvasNodeShapeUtil extends ShapeUtil<TPpmCanvasShape> {
  static override type = PPM_CANVAS_SHAPE_TYPE;

  static override props: RecordProps<TPpmCanvasShape> = {
    h: T.number,
    node: T.string,
    w: T.number,
  };

  override getDefaultProps(): TPpmCanvasShape["props"] {
    const node = createPpmCanvasNode({ authorId: "unknown", kind: "note", title: "" });
    return {
      h: node.visual.height,
      node: serializePpmCanvasNode(node),
      w: node.visual.width,
    };
  }

  override getGeometry(shape: TPpmCanvasShape) {
    return new Rectangle2d({ height: shape.props.h, isFilled: true, width: shape.props.w });
  }

  override canEdit() {
    return true;
  }

  override canResize() {
    return true;
  }

  override canReceiveNewChildrenOfType(shape: TPpmCanvasShape) {
    const parsed = parseSerializedPpmCanvasNode(shape.props.node);
    return (
      (parsed.status === "valid" || parsed.status === "migrated") &&
      (parsed.node.kind === "group" || parsed.node.kind === "frame")
    );
  }

  override component(shape: TPpmCanvasShape) {
    return <PpmCanvasNodeCard shape={shape} />;
  }

  override indicator(shape: TPpmCanvasShape) {
    // No React context here: read the grammar from the DOM so the outline matches canvas-v2.css exactly.
    const grammarV2 = Boolean(this.editor.getContainer().closest('[data-ppm-canvas-grammar="v2"]'));
    const parsed = grammarV2 ? parseSerializedPpmCanvasNode(shape.props.node) : undefined;
    const node = parsed && (parsed.status === "valid" || parsed.status === "migrated") ? parsed.node : undefined;
    const radius = nodeIndicatorRadius(grammarV2, node?.kind);
    return <rect height={shape.props.h} rx={radius} ry={radius} width={shape.props.w} />;
  }

  override onResize(shape: TPpmCanvasShape, info: TLResizeInfo<TPpmCanvasShape>) {
    const resized = resizeBox(shape, info, { minHeight: 96, minWidth: 160, maxHeight: 1200, maxWidth: 1600 });
    const parsed = parseSerializedPpmCanvasNode(shape.props.node);
    if (parsed.status === "unknown" || parsed.status === "corrupt") return resized;

    return {
      ...resized,
      props: {
        ...resized.props,
        node: serializePpmCanvasNode({
          ...parsed.node,
          visual: { ...parsed.node.visual, height: resized.props.h, width: resized.props.w },
        }),
      },
    };
  }
}

function PpmCanvasNodeCard({ shape }: { shape: TPpmCanvasShape }) {
  const ppmT = usePpmTranslation();
  const parsed = parseSerializedPpmCanvasNode(shape.props.node);

  if (parsed.status === "unknown" || parsed.status === "corrupt") {
    return (
      <HTMLContainer className="ppm-canvas-node ppm-canvas-node--fallback" data-ppm-canvas-node-state={parsed.status}>
        <strong>{ppmT(parsed.status === "unknown" ? "canvas.unknown_node" : "canvas.corrupt_node")}</strong>
        <span>{ppmT("canvas.fallback_description")}</span>
      </HTMLContainer>
    );
  }

  return (
    <HTMLContainer
      className={`ppm-canvas-node ppm-canvas-node--${parsed.node.kind} ${COLOR_CLASS[parsed.node.visual.color]}`}
      data-ppm-canvas-node-kind={parsed.node.kind}
    >
      <NodeEditor node={parsed.node} shape={shape} />
    </HTMLContainer>
  );
}

function NodeEditor({ node, shape }: { node: TPpmCanvasNode; shape: TPpmCanvasShape }) {
  const ppmT = usePpmTranslation();
  const editor = useEditor();
  const [orchestratorProjectionStatus, setOrchestratorProjectionStatus] = useState<string>();
  const grammarV2 = usePpmCanvasGrammarV2();
  if (node.kind === "work_item_ref") return <WorkItemProjectionCard node={node} shape={shape} />;
  if (node.kind === "work_items_view") return <WorkItemsViewNode node={node} shape={shape} />;

  if (node.kind === "pdf" || node.kind === "image" || node.kind === "reference") {
    return <MediaProjectionCard editor={editor} node={node} shape={shape} />;
  }

  if (node.kind === "diagram") return <DiagramNode node={node} shape={shape} />;
  if (node.kind === "deck") return <DeckNode node={node} shape={shape} />;

  if (node.kind === "page_ref" || node.kind === "attachment_ref" || (node.kind === "vault_file_ref" && node.binding)) {
    return <ContentProjectionCard node={node} shape={shape} />;
  }

  if (node.kind === "vault_file_ref") {
    return (
      <div className="ppm-canvas-node__content ppm-canvas-node__content--vault">
        <span className="ppm-canvas-node__kind">{ppmT("canvas.vault_file")}</span>
        <strong className="ppm-canvas-node__vault-title">{node.title}</strong>
        <span className="ppm-canvas-node__vault-meta">
          {node.extension.slice(1).toUpperCase()} · {ppmT("canvas.vault_version")} {node.source_version}
        </span>
        <a
          className="ppm-canvas-node__vault-link"
          href={node.source_url}
          onClick={stopEventPropagation}
          onKeyDown={stopEventPropagation}
          onPointerDown={stopEventPropagation}
        >
          {ppmT("canvas.open_vault")}
        </a>
      </div>
    );
  }

  if (node.kind === "git_ref") return <GitReferenceCard node={node} shape={shape} />;

  if (node.kind === "search") {
    if (grammarV2) return <FoundBySearchCard node={node} />;
    return (
      <div className="ppm-canvas-node__content ppm-agent-node ppm-agent-node--search">
        <span className="ppm-canvas-node__kind">Поиск по проекту</span>
        <strong>{node.title}</strong>
        <p>{node.query}</p>
        <div className="ppm-agent-node__citations">
          <span>Найденные источники · {node.results.length}</span>
          {node.results.slice(0, 5).map((result, index) => (
            <a
              href={result.source_url}
              key={result.result_id}
              onClick={stopEventPropagation}
              onKeyDown={stopEventPropagation}
              onPointerDown={stopEventPropagation}
            >
              <span>
                {index + 1}. {result.title}
              </span>
              <ExternalLink aria-hidden="true" />
            </a>
          ))}
        </div>
        <div className="ppm-agent-node__meta">
          <span>{node.retrieval_mode === "hybrid" ? "Гибридный поиск" : "Поиск по тексту"}</span>
          <span>
            {node.selected_shape_ids.length > 0 ? `Контекст · ${node.selected_shape_ids.length}` : "Весь проект"}
          </span>
          {node.degraded && <span>Ограниченный режим</span>}
          {node.service_run && <ServiceRunMeta run={node.service_run} />}
        </div>
      </div>
    );
  }

  if (node.kind === "orchestrator") {
    const onExpand = () => {
      try {
        const count = expandOrchestratorRun(editor, shape, node);
        setOrchestratorProjectionStatus(`Проекции обновлены · ${count}`);
      } catch {
        setOrchestratorProjectionStatus("Не удалось разложить запуск");
      }
    };
    return (
      <div className="ppm-canvas-node__content ppm-agent-node ppm-agent-node--orchestrator">
        <span className="ppm-canvas-node__kind">Оркестратор проекта</span>
        <strong>{node.title}</strong>
        <p className="ppm-agent-node__answer">{node.summary}</p>
        <div className="ppm-orchestrator-node__actions">
          <span>
            {node.actions.length > 0
              ? `Действия · ${node.action_summary.reviewed} из ${node.action_summary.total} рассмотрено`
              : "Результат без изменений"}
          </span>
          {node.actions.length === 0 ? (
            <small>Запуск не предложил изменений.</small>
          ) : (
            node.actions.slice(0, 4).map((action) => (
              <div data-status={action.status} key={action.action_id}>
                <div>
                  <strong>{action.title}</strong>
                  <small>{action.summary}</small>
                </div>
                {action.result_url ? (
                  <a
                    href={action.result_url}
                    onClick={stopEventPropagation}
                    onKeyDown={stopEventPropagation}
                    onPointerDown={stopEventPropagation}
                  >
                    {ORCHESTRATOR_ACTION_STATUS_LABELS[action.status]}
                    <ExternalLink aria-hidden="true" />
                  </a>
                ) : (
                  <span>{ORCHESTRATOR_ACTION_STATUS_LABELS[action.status]}</span>
                )}
              </div>
            ))
          )}
        </div>
        {node.trace.length > 0 && <OrchestratorTrace trace={node.trace} />}
        {orchestratorProjectionCount(node) > 0 && (
          <button
            className="ppm-orchestrator-node__expand"
            type="button"
            onClick={stopEventPropagation}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") onExpand();
              stopEventPropagation(event);
            }}
            onPointerDown={(event) => {
              stopEventPropagation(event);
              onExpand();
            }}
          >
            {orchestratorProjectionStatus ?? `Разложить запуск · ${orchestratorProjectionCount(node)}`}
          </button>
        )}
        {node.citations.length > 0 && (
          <div className="ppm-agent-node__citations">
            <span>Источники · {node.citations.length}</span>
            {node.citations.slice(0, 3).map((citation, index) => (
              <a
                href={citation.source_url}
                key={citation.citation_id}
                onClick={stopEventPropagation}
                onKeyDown={stopEventPropagation}
                onPointerDown={stopEventPropagation}
              >
                <span>
                  {index + 1}. {citation.title}
                </span>
                <ExternalLink aria-hidden="true" />
              </a>
            ))}
          </div>
        )}
        <div className="ppm-agent-node__meta">
          <span>{ORCHESTRATOR_RUN_STATUS_LABELS[node.run_status]}</span>
          {(node.provider || node.model) && <span>{[node.provider, node.model].filter(Boolean).join(" · ")}</span>}
          {node.action_summary.canonical_changes_applied && <span>Изменения применены</span>}
          {node.service_run && <ServiceRunTime run={node.service_run} />}
        </div>
      </div>
    );
  }

  if (node.kind === "orchtask") {
    return (
      <div className="ppm-canvas-node__content ppm-agent-node ppm-agent-node--orchtask">
        <span className="ppm-canvas-node__kind">Задача агента</span>
        <strong>{node.title}</strong>
        <p>{node.summary}</p>
        <div className="ppm-agent-node__meta">
          <span>{ORCHESTRATOR_ACTION_KIND_LABELS[node.action_kind]}</span>
          <span>{ORCHESTRATOR_ACTION_STATUS_LABELS[node.status]}</span>
          {node.canonical_changes_applied && <span>Изменения применены</span>}
        </div>
        {node.result_url && (
          <a
            className="ppm-orchestrator-node__result"
            href={node.result_url}
            onClick={stopEventPropagation}
            onKeyDown={stopEventPropagation}
            onPointerDown={stopEventPropagation}
          >
            Открыть результат
            <ExternalLink aria-hidden="true" />
          </a>
        )}
      </div>
    );
  }

  if (node.kind === "orchcall") {
    return (
      <div className="ppm-canvas-node__content ppm-agent-node ppm-agent-node--orchcall">
        <span className="ppm-canvas-node__kind">Шаг агента</span>
        <strong>{node.title}</strong>
        {node.summary && <p>{node.summary}</p>}
        <div className="ppm-agent-node__meta">
          {node.tool_mode && <span>{ORCHESTRATOR_TOOL_MODE_LABELS[node.tool_mode]}</span>}
          <span>{orchestratorCallStatusLabel(node)}</span>
          <time dateTime={node.occurred_at}>{formatOrchestratorTraceTime(node.occurred_at)}</time>
        </div>
      </div>
    );
  }

  if (node.kind === "agent_query") {
    return (
      <div className="ppm-canvas-node__content ppm-agent-node ppm-agent-node--query">
        <span className="ppm-canvas-node__kind">{ppmT("ask_project.query_kind")}</span>
        <strong>{node.title}</strong>
        <p>{node.query}</p>
        <div className="ppm-agent-node__meta">
          {node.service_run ? (
            <ServiceRunMeta run={node.service_run} />
          ) : (
            <span>{ppmT(AGENT_RUN_STATUS_LABELS[node.run_status])}</span>
          )}
          <span>
            {node.selected_shape_ids.length > 0
              ? `${ppmT("ask_project.selected_context")} · ${node.selected_shape_ids.length}`
              : ppmT("ask_project.project_scope")}
          </span>
        </div>
      </div>
    );
  }

  if (node.kind === "agent_answer") {
    return (
      <div className="ppm-canvas-node__content ppm-agent-node ppm-agent-node--answer">
        <span className="ppm-canvas-node__kind">{ppmT("ask_project.answer_kind")}</span>
        <strong>{node.title}</strong>
        <p className="ppm-agent-node__answer">{node.body}</p>
        {node.citations.length > 0 && (
          <div className="ppm-agent-node__citations">
            <span>{ppmT("ask_project.sources")}</span>
            {node.citations.map((citation, index) => (
              <a
                href={citation.source_url}
                key={citation.citation_id}
                rel="noreferrer"
                target="_blank"
                onClick={stopEventPropagation}
                onKeyDown={stopEventPropagation}
                onPointerDown={stopEventPropagation}
              >
                <span>
                  {index + 1}. {citation.title}
                </span>
                <ExternalLink aria-hidden="true" />
              </a>
            ))}
          </div>
        )}
        <div className="ppm-agent-node__meta">
          {node.service_run ? (
            <ServiceRunMeta run={node.service_run} />
          ) : (
            <span>{ppmT(AGENT_RUN_STATUS_LABELS[node.run_status])}</span>
          )}
        </div>
      </div>
    );
  }

  return <NativeNodeCard editor={editor} node={node} shape={shape} />;
}

function FoundBySearchCard({ node }: { node: TPpmCanvasSearchNode }) {
  const ppmT = usePpmTranslation();
  const projectionContext = useContext(PpmWorkItemProjectionContext);
  const results = node.results.slice(0, 5);
  const bindings = [...projectionContext.bindingsByShapeId.values()];
  const stale = results.map((result) => isCitationStale(result, bindings));
  const firstStale = results.find((_, index) => stale[index]);
  const excerpt = results[0]?.excerpt.trim();
  return (
    <div className="ppm-canvas-node__content ppm-found-card">
      <header className="ppm-found-card__header">
        <Search aria-hidden="true" />
        <span>{ppmT("canvas.found_by_search")}</span>
      </header>
      <p className="ppm-found-card__query">{fillCanvasTemplate(ppmT("canvas.found_query"), { query: node.query })}</p>
      {excerpt ? (
        <blockquote className="ppm-found-card__excerpt" data-code={results[0].source_type === "git_code" || undefined}>
          {excerpt}
        </blockquote>
      ) : (
        <p className="ppm-found-card__empty">{ppmT("canvas.found_no_excerpt")}</p>
      )}
      {results.length > 0 && (
        <ol className="ppm-found-card__citations">
          {results.map((result, index) => {
            const parts = citationParts(result);
            const text = [
              parts.title,
              parts.page ? fillCanvasTemplate(ppmT("canvas.citation_page"), { page: parts.page }) : null,
              parts.lines ? fillCanvasTemplate(ppmT("canvas.citation_lines"), { range: parts.lines }) : null,
              parts.version,
            ]
              .filter(Boolean)
              .join(" · ");
            const label = fillCanvasTemplate(
              ppmT(stale[index] ? "canvas.citation_label_stale" : "canvas.citation_label"),
              { index: index + 1, text }
            );
            return (
              <li key={result.result_id}>
                <a
                  className="ppm-citation-chip"
                  data-stale={stale[index] || undefined}
                  href={result.source_url}
                  aria-label={label}
                  rel={isExternalHref(result.source_url) ? "noreferrer" : undefined}
                  target={isExternalHref(result.source_url) ? "_blank" : undefined}
                  title={label}
                  onClick={stopEventPropagation}
                  onKeyDown={stopEventPropagation}
                  onPointerDown={stopEventPropagation}
                >
                  <span className="ppm-citation-chip__index">{index + 1}</span>
                  <span className="ppm-citation-chip__text">{text}</span>
                  {stale[index] && <RefreshCw aria-hidden="true" />}
                </a>
              </li>
            );
          })}
        </ol>
      )}
      {firstStale && (
        <p className="ppm-found-card__stale">
          {ppmT("canvas.citation_stale")} ·{" "}
          <a
            href={firstStale.source_url}
            rel={isExternalHref(firstStale.source_url) ? "noreferrer" : undefined}
            target={isExternalHref(firstStale.source_url) ? "_blank" : undefined}
            onClick={stopEventPropagation}
            onKeyDown={stopEventPropagation}
            onPointerDown={stopEventPropagation}
          >
            {ppmT("canvas.citation_open")}
          </a>
        </p>
      )}
    </div>
  );
}

const NATIVE_NODE_LABELS = {
  note: "canvas.note_title",
  document: "canvas.document_title",
  checklist: "canvas.checklist_title",
  table: "canvas.table_title",
  code: "canvas.code_title",
  group: "canvas.group_title",
  frame: "canvas.frame_title",
  board_link: "canvas.board_link_title",
  work_items_view: "canvas.work_items_view_title",
  diagram: "canvas.diagram_title",
  deck: "canvas.deck_title",
} as const satisfies Record<TPpmCanvasOwnedNode["kind"], TPpmTranslationKey>;

function NativeNodeCard({
  editor,
  node,
  shape,
}: {
  editor: Editor;
  node: TPpmCanvasOwnedNode;
  shape: TPpmCanvasShape;
}) {
  const ppmT = usePpmTranslation();
  const boardNavigation = useContext(PpmCanvasBoardNavigationContext);
  const readonly = editor.getInstanceState().isReadonly;
  const collapsed = Boolean(node.visual.collapsed);
  const grammarV2 = usePpmCanvasGrammarV2();
  const { currentLocale } = useTranslation();
  const isSection = node.kind === "group" || node.kind === "frame";
  const childCount = useValue(
    "ppm section object count",
    () => (grammarV2 && isSection ? editor.getSortedChildIdsForParent(shape.id).length : 0),
    [editor, grammarV2, isSection, shape.id]
  );

  return (
    <div className="ppm-canvas-node__native" data-collapsed={collapsed || undefined}>
      <header className="ppm-canvas-node__chrome">
        {grammarV2 ? (
          <span className="ppm-canvas-node__type">
            <OwnNodeGlyph kind={node.kind} />
            {ppmT(OWN_NODE_KIND_KEYS[node.kind])}
          </span>
        ) : (
          <span>{ppmT(NATIVE_NODE_LABELS[node.kind])}</span>
        )}
        {!readonly && (
          <div>
            <button
              type="button"
              aria-label={ppmT(collapsed ? "canvas.node_expand" : "canvas.node_collapse")}
              title={ppmT(collapsed ? "canvas.node_expand" : "canvas.node_collapse")}
              onClick={stopEventPropagation}
              onKeyDown={(event) => runCanvasKeyboardAction(event, () => toggleCollapsed(editor, shape, node))}
              onPointerDown={(event) => runCanvasPointerAction(event, () => toggleCollapsed(editor, shape, node))}
            >
              {collapsed ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
            </button>
            <button
              type="button"
              aria-label={ppmT("canvas.node_duplicate")}
              title={ppmT("canvas.node_duplicate")}
              onClick={stopEventPropagation}
              onKeyDown={(event) => runCanvasKeyboardAction(event, () => duplicateNode(editor, shape, node))}
              onPointerDown={(event) => runCanvasPointerAction(event, () => duplicateNode(editor, shape, node))}
            >
              <Copy aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={ppmT("canvas.node_remove")}
              title={ppmT("canvas.node_remove")}
              onClick={stopEventPropagation}
              onKeyDown={(event) => runCanvasKeyboardAction(event, () => editor.deleteShape(shape.id))}
              onPointerDown={(event) => runCanvasPointerAction(event, () => editor.deleteShape(shape.id))}
            >
              <Trash2 aria-hidden="true" />
            </button>
          </div>
        )}
      </header>
      <input
        aria-label={ppmT(NATIVE_NODE_LABELS[node.kind])}
        className="ppm-canvas-node__title"
        disabled={readonly}
        maxLength={160}
        size={grammarV2 && isSection ? Math.min(48, Math.max(8, node.title.length + 1)) : undefined}
        value={node.title}
        onChange={(event) => updateNode(editor, shape, node, { title: event.currentTarget.value })}
        onKeyDown={stopEventPropagation}
        onPointerDown={stopEventPropagation}
      />
      {grammarV2 && isSection && (
        <span className="ppm-canvas-section__count">
          <span aria-hidden="true">·</span>
          {fillCanvasTemplate(ppmT(sectionObjectCountKey(childCount, currentLocale)), { count: childCount })}
        </span>
      )}
      {!collapsed && (
        <div className="ppm-canvas-node__content ppm-canvas-node__native-content">
          {(node.kind === "note" || node.kind === "document" || node.kind === "group" || node.kind === "frame") && (
            <textarea
              aria-label={ppmT(
                node.kind === "note"
                  ? "canvas.note_body_placeholder"
                  : node.kind === "document"
                    ? "canvas.document_body_placeholder"
                    : "canvas.group_body_placeholder"
              )}
              className="ppm-canvas-node__body"
              disabled={readonly}
              maxLength={50_000}
              placeholder={ppmT(
                node.kind === "note"
                  ? "canvas.note_body_placeholder"
                  : node.kind === "document"
                    ? "canvas.document_body_placeholder"
                    : "canvas.group_body_placeholder"
              )}
              value={node.body}
              onChange={(event) => updateNode(editor, shape, node, { body: event.currentTarget.value })}
              onKeyDown={stopEventPropagation}
              onPointerDown={stopEventPropagation}
            />
          )}
          {node.kind === "checklist" && (
            <ChecklistEditor editor={editor} node={node} readonly={readonly} shape={shape} />
          )}
          {node.kind === "table" && <TableEditor editor={editor} node={node} readonly={readonly} shape={shape} />}
          {node.kind === "code" && (
            <>
              <label className="ppm-canvas-code__language">
                <span>Язык</span>
                <input
                  disabled={readonly}
                  maxLength={64}
                  value={node.language}
                  onChange={(event) => updateNode(editor, shape, node, { language: event.currentTarget.value })}
                  onKeyDown={stopEventPropagation}
                  onPointerDown={stopEventPropagation}
                />
              </label>
              <textarea
                aria-label={ppmT("canvas.code_body_placeholder")}
                className="ppm-canvas-node__body ppm-canvas-code__body"
                disabled={readonly}
                maxLength={100_000}
                placeholder={ppmT("canvas.code_body_placeholder")}
                value={node.code}
                onChange={(event) => updateNode(editor, shape, node, { code: event.currentTarget.value })}
                onKeyDown={stopEventPropagation}
                onPointerDown={stopEventPropagation}
              />
              <small className="ppm-canvas-code__notice">{ppmT("canvas.code_safe_notice")}</small>
            </>
          )}
          {node.kind === "board_link" && (
            <button
              type="button"
              className="ppm-canvas-board-link"
              onClick={stopEventPropagation}
              onKeyDown={(event) =>
                runCanvasKeyboardAction(event, () => boardNavigation.onOpenBoard(node.target_board_id))
              }
              onPointerDown={(event) =>
                runCanvasPointerAction(event, () => boardNavigation.onOpenBoard(node.target_board_id))
              }
            >
              <ExternalLink aria-hidden="true" />
              {ppmT("canvas.open_board")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ChecklistEditor({
  editor,
  node,
  readonly,
  shape,
}: {
  editor: Editor;
  node: Extract<TPpmCanvasOwnedNode, { kind: "checklist" }>;
  readonly: boolean;
  shape: TPpmCanvasShape;
}) {
  const ppmT = usePpmTranslation();
  return (
    <div className="ppm-canvas-checklist">
      {node.items.map((item) => (
        <label key={item.id}>
          <input
            type="checkbox"
            checked={item.checked}
            disabled={readonly}
            onChange={(event) =>
              updateNode(editor, shape, node, {
                items: node.items.map((current) =>
                  current.id === item.id ? { ...current, checked: event.currentTarget.checked } : current
                ),
              })
            }
            onPointerDown={stopEventPropagation}
          />
          <input
            value={item.text}
            disabled={readonly}
            maxLength={1_000}
            onChange={(event) =>
              updateNode(editor, shape, node, {
                items: node.items.map((current) =>
                  current.id === item.id ? { ...current, text: event.currentTarget.value } : current
                ),
              })
            }
            onKeyDown={stopEventPropagation}
            onPointerDown={stopEventPropagation}
          />
          {!readonly && (
            <button
              type="button"
              aria-label={ppmT("canvas.node_remove")}
              onClick={stopEventPropagation}
              onKeyDown={(event) =>
                runCanvasKeyboardAction(event, () =>
                  updateNode(editor, shape, node, { items: node.items.filter((current) => current.id !== item.id) })
                )
              }
              onPointerDown={(event) =>
                runCanvasPointerAction(event, () =>
                  updateNode(editor, shape, node, { items: node.items.filter((current) => current.id !== item.id) })
                )
              }
            >
              <Trash2 aria-hidden="true" />
            </button>
          )}
        </label>
      ))}
      {!readonly && (
        <button
          type="button"
          onClick={stopEventPropagation}
          onKeyDown={(event) =>
            runCanvasKeyboardAction(event, () =>
              updateNode(editor, shape, node, {
                items: [...node.items, { id: crypto.randomUUID(), text: "", checked: false }],
              })
            )
          }
          onPointerDown={(event) =>
            runCanvasPointerAction(event, () =>
              updateNode(editor, shape, node, {
                items: [...node.items, { id: crypto.randomUUID(), text: "", checked: false }],
              })
            )
          }
        >
          <Plus aria-hidden="true" />
          {ppmT("canvas.checklist_add_item")}
        </button>
      )}
    </div>
  );
}

function TableEditor({
  editor,
  node,
  readonly,
  shape,
}: {
  editor: Editor;
  node: Extract<TPpmCanvasOwnedNode, { kind: "table" }>;
  readonly: boolean;
  shape: TPpmCanvasShape;
}) {
  const ppmT = usePpmTranslation();
  return (
    <div className="ppm-canvas-table">
      <table>
        <thead>
          <tr>
            {node.columns.map((column) => (
              <th key={column.id}>
                <input
                  disabled={readonly}
                  maxLength={160}
                  value={column.label}
                  onChange={(event) =>
                    updateNode(editor, shape, node, {
                      columns: node.columns.map((current) =>
                        current.id === column.id ? { ...current, label: event.currentTarget.value } : current
                      ),
                    })
                  }
                  onKeyDown={stopEventPropagation}
                  onPointerDown={stopEventPropagation}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {node.rows.map((row) => (
            <tr key={row.id}>
              {node.columns.map((column) => (
                <td key={column.id}>
                  <input
                    disabled={readonly}
                    maxLength={5_000}
                    value={row.cells[column.id] ?? ""}
                    onChange={(event) =>
                      updateNode(editor, shape, node, {
                        rows: node.rows.map((current) =>
                          current.id === row.id
                            ? { ...current, cells: { ...current.cells, [column.id]: event.currentTarget.value } }
                            : current
                        ),
                      })
                    }
                    onKeyDown={stopEventPropagation}
                    onPointerDown={stopEventPropagation}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!readonly && (
        <div className="ppm-canvas-table__actions">
          <button
            type="button"
            onClick={stopEventPropagation}
            onKeyDown={(event) =>
              runCanvasKeyboardAction(event, () =>
                updateNode(editor, shape, node, {
                  rows: [
                    ...node.rows,
                    {
                      id: crypto.randomUUID(),
                      cells: Object.fromEntries(node.columns.map((column) => [column.id, ""])),
                    },
                  ],
                })
              )
            }
            onPointerDown={(event) =>
              runCanvasPointerAction(event, () =>
                updateNode(editor, shape, node, {
                  rows: [
                    ...node.rows,
                    {
                      id: crypto.randomUUID(),
                      cells: Object.fromEntries(node.columns.map((column) => [column.id, ""])),
                    },
                  ],
                })
              )
            }
          >
            <Plus aria-hidden="true" /> {ppmT("canvas.table_add_row")}
          </button>
          {node.columns.length < 20 && (
            <button
              type="button"
              onClick={stopEventPropagation}
              onKeyDown={(event) =>
                runCanvasKeyboardAction(event, () =>
                  updateNode(editor, shape, node, {
                    columns: [...node.columns, { id: crypto.randomUUID(), label: ppmT("canvas.table_add_column") }],
                  })
                )
              }
              onPointerDown={(event) =>
                runCanvasPointerAction(event, () =>
                  updateNode(editor, shape, node, {
                    columns: [...node.columns, { id: crypto.randomUUID(), label: ppmT("canvas.table_add_column") }],
                  })
                )
              }
            >
              <Plus aria-hidden="true" /> {ppmT("canvas.table_add_column")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function toggleCollapsed(editor: Editor, shape: TPpmCanvasShape, node: TPpmCanvasOwnedNode) {
  const collapsed = Boolean(node.visual.collapsed);
  const expandedHeight = collapsed ? (node.visual.expanded_height ?? node.visual.height) : shape.props.h;
  const height = collapsed ? Math.min(expandedHeight, 104) : expandedHeight;
  const updated = updatePpmCanvasNode(node, {
    visual: {
      ...node.visual,
      collapsed: !collapsed,
      expanded_height: expandedHeight,
      height,
    },
  });
  editor.updateShape<TPpmCanvasShape>({
    id: shape.id,
    type: shape.type,
    props: { h: height, node: serializePpmCanvasNode(updated) },
  });
}

function duplicateNode(editor: Editor, shape: TPpmCanvasShape, node: TPpmCanvasOwnedNode) {
  const id = `shape:${crypto.randomUUID()}` as TPpmCanvasShape["id"];
  const duplicate = duplicatePpmCanvasNode(node, node.author_id);
  editor.createShape<TPpmCanvasShape>({
    id,
    type: PPM_CANVAS_SHAPE_TYPE,
    x: shape.x + 36,
    y: shape.y + 36,
    props: { h: shape.props.h, node: serializePpmCanvasNode(duplicate), w: shape.props.w },
  });
  editor.select(id);
}

const AGENT_RUN_STATUS_LABELS = {
  completed: "ask_project.status_completed",
  degraded: "ask_project.status_degraded",
  no_sources: "ask_project.status_no_sources",
} as const satisfies Record<
  Extract<TPpmCanvasNode, { kind: "agent_query" | "agent_answer" }>["run_status"],
  TPpmTranslationKey
>;

const ORCHESTRATOR_RUN_STATUS_LABELS: Record<Extract<TPpmCanvasNode, { kind: "orchestrator" }>["run_status"], string> =
  {
    queued: "В очереди",
    running: "Выполняется",
    awaiting_approval: "Ждёт решения",
    applying: "Применяется",
    completed: "Завершён",
    failed: "Ошибка",
    timed_out: "Истёк лимит",
    cancelled: "Отменён",
    rejected: "Отклонён",
  };

const SERVICE_RUN_STATUS_LABELS: Record<TPpmCanvasServiceRunEnvelope["status"], string> = {
  queued: "В очереди",
  retrieving: "Ищет источники",
  completing: "Формирует ответ",
  running: "Выполняется",
  awaiting_approval: "Ждёт решения",
  applying: "Применяется",
  completed: "Завершён",
  degraded: "Ограниченный режим",
  no_sources: "Нет источников",
  failed: "Ошибка",
  timed_out: "Истёк лимит",
  cancelled: "Отменён",
  rejected: "Отклонён",
};

function ServiceRunTime({ run }: { run: TPpmCanvasServiceRunEnvelope }) {
  return (
    <time dateTime={run.updated_at} title={run.policy_version}>
      {formatOrchestratorTraceTime(run.updated_at)}
    </time>
  );
}

function ServiceRunMeta({ run }: { run: TPpmCanvasServiceRunEnvelope }) {
  return (
    <>
      <span title={run.policy_version}>Запуск · {SERVICE_RUN_STATUS_LABELS[run.status]}</span>
      {(run.provider || run.model) && <span>{[run.provider, run.model].filter(Boolean).join(" · ")}</span>}
      <ServiceRunTime run={run} />
    </>
  );
}

const ORCHESTRATOR_ACTION_STATUS_LABELS: Record<
  Extract<TPpmCanvasNode, { kind: "orchestrator" }>["actions"][number]["status"],
  string
> = {
  proposed: "Предложено",
  approved: "Принято",
  rejected: "Отклонено",
  applying: "Применяется",
  applied: "Выполнено",
  conflict: "Конфликт",
  failed: "Ошибка",
  cancelled: "Отменено",
};

const ORCHESTRATOR_ACTION_KIND_LABELS: Record<Extract<TPpmCanvasNode, { kind: "orchtask" }>["action_kind"], string> = {
  create_work_items: "Задачи проекта",
  apply_semantic_edges: "Смысловая связь",
  write_vault_file: "Файл Хранилища",
};

const ORCHESTRATOR_TOOL_MODE_LABELS: Record<"read" | "propose" | "apply", string> = {
  apply: "Изменение",
  propose: "Предложение",
  read: "Чтение",
};

const ORCHESTRATOR_TOOL_STATUS_LABELS: Record<"completed" | "failed", string> = {
  completed: "Выполнено",
  failed: "Ошибка",
};

const PPM_ORCHESTRATOR_CONNECTION_META_KEY = "ppmOrchestratorConnectionId";

export function expandOrchestratorRun(
  editor: Editor,
  sourceShape: TPpmCanvasShape,
  node: Extract<TPpmCanvasNode, { kind: "orchestrator" }>
) {
  const now = new Date().toISOString();
  const projectionTrace = node.trace.filter(
    (item): item is Extract<TPpmCanvasOrchestratorTrace, { kind: "action_status" | "tool_call" }> =>
      item.kind === "action_status" || item.kind === "tool_call"
  );
  const taskX = sourceShape.x + sourceShape.props.w + 80;
  const projectionShapes = new Map<string, TPpmCanvasShape>([[orchestratorProjectionRefKey(node), sourceShape]]);
  let projectionCount = 0;

  node.actions.forEach((action, actionIndex) => {
    const task = createPpmOrchestratorTaskNode({ action, authorId: node.author_id, now, runId: node.run_id });
    const taskShape = upsertOrchestratorProjection(editor, task, taskX, sourceShape.y + actionIndex * 220);
    if (taskShape) projectionShapes.set(orchestratorProjectionRefKey(task), taskShape);
    projectionCount += 1;

    projectionTrace
      .filter((item) => item.action_id === action.action_id)
      .forEach((trace, traceIndex) => {
        const call = createPpmOrchestratorCallNode({
          action,
          authorId: node.author_id,
          now,
          runId: node.run_id,
          trace,
        });
        const callShape = upsertOrchestratorProjection(
          editor,
          call,
          taskX + task.visual.width + 60 + traceIndex * (call.visual.width + 32),
          sourceShape.y + actionIndex * 220 + 20
        );
        if (callShape) projectionShapes.set(orchestratorProjectionRefKey(call), callShape);
        projectionCount += 1;
      });
  });

  projectionTrace
    .filter((trace) => trace.kind === "tool_call" && !trace.action_id)
    .forEach((trace, traceIndex) => {
      const call = createPpmOrchestratorCallNode({
        authorId: node.author_id,
        now,
        runId: node.run_id,
        trace,
      });
      const callShape = upsertOrchestratorProjection(
        editor,
        call,
        sourceShape.x + traceIndex * (call.visual.width + 32),
        sourceShape.y + sourceShape.props.h + 80
      );
      if (callShape) projectionShapes.set(orchestratorProjectionRefKey(call), callShape);
      projectionCount += 1;
    });

  for (const connection of createPpmOrchestratorProjectionConnections(node)) {
    const fromShape = projectionShapes.get(orchestratorProjectionRefKey(connection.from));
    const toShape = projectionShapes.get(orchestratorProjectionRefKey(connection.to));
    if (fromShape && toShape) {
      ensureOrchestratorConnection(editor, fromShape, toShape, connection.connection_id, node.run_id);
    }
  }
  return projectionCount;
}

function orchestratorProjectionRefKey(
  projection:
    | TPpmCanvasOrchestratorProjectionRef
    | Extract<TPpmCanvasNode, { kind: "orchestrator" | "orchtask" | "orchcall" }>
) {
  if (projection.kind === "orchestrator") return `orchestrator:${projection.run_id}`;
  if (projection.kind === "orchtask") return `orchtask:${projection.run_id}:${projection.action_id}`;
  return `orchcall:${projection.run_id}:${projection.trace_id}`;
}

function upsertOrchestratorProjection(
  editor: Editor,
  incoming: Extract<TPpmCanvasNode, { kind: "orchtask" | "orchcall" }>,
  x: number,
  y: number
): TPpmCanvasShape | undefined {
  const existing = editor
    .getCurrentPageShapes()
    .filter((shape): shape is TPpmCanvasShape => shape.type === PPM_CANVAS_SHAPE_TYPE)
    .find((shape) => {
      const parsed = parseSerializedPpmCanvasNode(shape.props.node);
      if (parsed.status !== "valid" && parsed.status !== "migrated") return false;
      return (
        (parsed.node.kind === "orchtask" || parsed.node.kind === "orchcall") &&
        isSamePpmOrchestratorProjection(parsed.node, incoming)
      );
    });

  if (existing) {
    const parsed = parseSerializedPpmCanvasNode(existing.props.node);
    if (parsed.status !== "valid" && parsed.status !== "migrated") return undefined;
    editor.updateShape<TPpmCanvasShape>({
      id: existing.id,
      type: PPM_CANVAS_SHAPE_TYPE,
      props: {
        node: serializePpmCanvasNode({
          ...incoming,
          author_id: parsed.node.author_id,
          created_at: parsed.node.created_at,
          visual: parsed.node.visual,
        }),
      },
    });
    return existing;
  }

  const id = createShapeId();
  editor.createShape<TPpmCanvasShape>({
    id,
    type: PPM_CANVAS_SHAPE_TYPE,
    x,
    y,
    props: {
      h: incoming.visual.height,
      node: serializePpmCanvasNode(incoming),
      w: incoming.visual.width,
    },
  });
  return editor.getShape<TPpmCanvasShape>(id);
}

function ensureOrchestratorConnection(
  editor: Editor,
  fromShape: TPpmCanvasShape,
  toShape: TPpmCanvasShape,
  connectionId: string,
  runId: string
) {
  const matchingArrows = editor
    .getCurrentPageShapes()
    .filter(
      (shape): shape is TLArrowShape =>
        shape.type === "arrow" && shape.meta[PPM_ORCHESTRATOR_CONNECTION_META_KEY] === connectionId
    );
  const validArrow = matchingArrows.find((arrow) => {
    const bindings = editor.getBindingsFromShape<TLArrowBinding>(arrow, "arrow");
    return (
      bindings.some((binding) => binding.props.terminal === "start" && binding.toId === fromShape.id) &&
      bindings.some((binding) => binding.props.terminal === "end" && binding.toId === toShape.id)
    );
  });
  const staleArrowIds = matchingArrows.filter((arrow) => arrow.id !== validArrow?.id).map((arrow) => arrow.id);
  if (staleArrowIds.length > 0) editor.deleteShapes(staleArrowIds);
  if (validArrow) return;

  const fromBounds = editor.getShapePageBounds(fromShape);
  const toBounds = editor.getShapePageBounds(toShape);
  if (!fromBounds || !toBounds) return;

  const start = fromBounds.center;
  const end = toBounds.center;
  const arrowId = createShapeId();
  editor.createShape<TLArrowShape>({
    id: arrowId,
    isLocked: true,
    meta: {
      [PPM_ORCHESTRATOR_CONNECTION_META_KEY]: connectionId,
      ppmOrchestratorRunId: runId,
    },
    props: {
      color: "violet",
      dash: "draw",
      end: { x: end.x - start.x, y: end.y - start.y },
      size: "s",
      start: { x: 0, y: 0 },
    },
    type: "arrow",
    x: start.x,
    y: start.y,
  });
  editor.createBindings<TLArrowBinding>([
    {
      fromId: arrowId,
      props: { terminal: "start" },
      toId: fromShape.id,
      type: "arrow",
    },
    {
      fromId: arrowId,
      props: { terminal: "end" },
      toId: toShape.id,
      type: "arrow",
    },
  ]);
  editor.sendToBack([arrowId]);
}

function OrchestratorTrace({ trace }: { trace: TPpmCanvasOrchestratorTrace[] }) {
  const latestTrace: TPpmCanvasOrchestratorTrace[] = [];
  for (let index = trace.length - 1; index >= Math.max(0, trace.length - 4); index -= 1) {
    const item = trace[index];
    if (item) latestTrace.push(item);
  }

  return (
    <div className="ppm-orchestrator-node__trace" aria-label="Хронология запуска">
      <span>Хронология · {trace.length}</span>
      {latestTrace.map((item) => (
        <div key={item.trace_id}>
          <i aria-hidden="true" />
          <span>{orchestratorTraceLabel(item)}</span>
          <time dateTime={item.occurred_at}>{formatOrchestratorTraceTime(item.occurred_at)}</time>
        </div>
      ))}
    </div>
  );
}

function orchestratorTraceLabel(item: TPpmCanvasOrchestratorTrace) {
  if (item.kind === "run_created") return "Запуск создан";
  if (item.kind === "run_status") return ORCHESTRATOR_RUN_STATUS_LABELS[item.status];
  if (item.kind === "tool_call") return `${item.title} · ${ORCHESTRATOR_TOOL_STATUS_LABELS[item.status]}`;
  const status = ORCHESTRATOR_ACTION_STATUS_LABELS[item.status];
  return item.action_title ? `${item.action_title} · ${status}` : status;
}

function orchestratorProjectionCount(node: Extract<TPpmCanvasNode, { kind: "orchestrator" }>) {
  return (
    node.actions.length + node.trace.filter((item) => item.kind === "action_status" || item.kind === "tool_call").length
  );
}

function orchestratorCallStatusLabel(node: Extract<TPpmCanvasNode, { kind: "orchcall" }>) {
  if (node.trace_kind === "tool_call")
    return ORCHESTRATOR_TOOL_STATUS_LABELS[node.status as keyof typeof ORCHESTRATOR_TOOL_STATUS_LABELS];
  return ORCHESTRATOR_ACTION_STATUS_LABELS[node.status as keyof typeof ORCHESTRATOR_ACTION_STATUS_LABELS];
}

function formatOrchestratorTraceTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
  }).format(date);
}

const GIT_OBJECT_LABELS = {
  repository: "canvas.git_repository",
  branch: "canvas.git_branch",
  commit: "canvas.git_commit",
  pull_request: "canvas.git_pull_request",
} as const satisfies Record<Extract<TPpmCanvasNode, { kind: "git_ref" }>["object_type"], TPpmTranslationKey>;

function GitReferenceCard({
  node,
  shape,
}: {
  node: Extract<TPpmCanvasNode, { kind: "git_ref" }>;
  shape: TPpmCanvasShape;
}) {
  const ppmT = usePpmTranslation();
  const projectionContext = useContext(PpmWorkItemProjectionContext);
  const resolved = projectionContext.bindingsByShapeId.get(shape.id);
  const binding: TPpmCanvasGitBinding | undefined =
    resolved && ["repository", "branch", "commit", "pull_request"].includes(resolved.entity_type)
      ? (resolved as TPpmCanvasGitBinding)
      : undefined;
  const grammarV2 = usePpmCanvasGrammarV2();

  if (node.binding && !binding) {
    return (
      <div className="ppm-work-item-card ppm-work-item-card--loading">
        <span className="ppm-canvas-node__kind">{ppmT(GIT_OBJECT_LABELS[node.object_type])}</span>
        <strong>{node.title}</strong>
        <button type="button" onClick={projectionContext.onRefresh} onPointerDown={stopEventPropagation}>
          <RefreshCw aria-hidden="true" />
          {ppmT("canvas.refresh_sources")}
        </button>
      </div>
    );
  }

  const display = binding?.source.display;
  const sourceUrl = binding?.source.identity.source_url ?? node.canonical_url;
  const unavailable = display?.source_status === "deleted" || display?.source_status === "archived";
  const workItems = display?.work_items ?? [];
  return (
    <div
      className={
        grammarV2
          ? "ppm-canvas-node__content ppm-canvas-node__content--vault ppm-live-card"
          : "ppm-canvas-node__content ppm-canvas-node__content--vault"
      }
      data-git-object={display?.object_type ?? node.object_type}
      data-source-status={display?.source_status ?? "legacy"}
    >
      {grammarV2 ? (
        <LiveSourceHeader
          icon={
            (display?.object_type ?? node.object_type) === "pull_request"
              ? GitPullRequest
              : (display?.object_type ?? node.object_type) === "branch"
                ? GitBranch
                : (display?.object_type ?? node.object_type) === "commit"
                  ? GitCommitHorizontal
                  : FolderGit2
          }
          identifier={
            (display?.object_type ?? node.object_type) === "commit"
              ? display?.commit_sha.slice(0, 7)
              : `${ppmT(GIT_OBJECT_LABELS[display?.object_type ?? node.object_type])}${display?.ref ? ` ${display.ref}` : ""}`
          }
          source="code"
          sourceLabel={ppmT(LIVE_SOURCE_LABEL_KEYS.code)}
        />
      ) : (
        <span className="ppm-canvas-node__kind">
          {ppmT(GIT_OBJECT_LABELS[display?.object_type ?? node.object_type])}
        </span>
      )}
      <strong className="ppm-canvas-node__vault-title">{display?.title ?? node.title}</strong>
      <span className="ppm-canvas-node__vault-meta">
        {(display?.provider ?? node.provider).toUpperCase()} · {display?.repository_name ?? node.repository_name}
      </span>
      {(workItems.length > 0 || node.work_item_key) && (
        <span className="ppm-canvas-node__vault-meta">
          {ppmT("canvas.git_linked_work_item")}:{" "}
          {workItems.map((item) => item.identifier).join(", ") || node.work_item_key}
        </span>
      )}
      {sourceUrl &&
        !unavailable &&
        (grammarV2 ? (
          <LiveOpenLink
            external
            href={sourceUrl}
            label={fillCanvasTemplate(ppmT(LIVE_SOURCE_OPEN_KEYS.code), { name: `«${display?.title ?? node.title}»` })}
          />
        ) : (
          <a
            className="ppm-canvas-node__vault-link"
            href={sourceUrl}
            target="_blank"
            rel="noreferrer"
            onClick={stopEventPropagation}
            onKeyDown={stopEventPropagation}
            onPointerDown={stopEventPropagation}
          >
            <ExternalLink aria-hidden="true" />
            {ppmT("canvas.open_git")}
          </a>
        ))}
      {unavailable && <span className="ppm-work-item-card__error">{ppmT("canvas.source_unavailable")}</span>}
      {binding && projectionContext.canEdit && (
        <button
          type="button"
          aria-label={grammarV2 ? ppmT("canvas.remove_projection") : undefined}
          className={grammarV2 ? "ppm-live-card__remove" : "ppm-work-item-card__remove"}
          disabled={projectionContext.pendingWorkItemIds.has(binding.entity_id)}
          title={grammarV2 ? ppmT("canvas.remove_projection") : undefined}
          onClick={() => projectionContext.onRemove(shape, binding)}
          onPointerDown={stopEventPropagation}
        >
          <Trash2 aria-hidden="true" />
          {!grammarV2 && ppmT("canvas.remove_projection")}
        </button>
      )}
    </div>
  );
}

function WorkItemsViewNode({
  node,
  shape,
}: {
  node: Extract<TPpmCanvasNode, { kind: "work_items_view" }>;
  shape: TPpmCanvasShape;
}) {
  const ppmT = usePpmTranslation();
  const editor = useEditor();
  const projectionContext = useContext(PpmWorkItemProjectionContext);
  const readonly = editor.getInstanceState().isReadonly;
  const [response, setResponse] = useState<TPpmWorkItemsViewResponse>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [draftTitle, setDraftTitle] = useState("");
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [draggedId, setDraggedId] = useState<string>();
  const [searchDraft, setSearchDraft] = useState(node.filters.query);
  const query = useMemo<TPpmWorkItemsViewQuery>(
    () => ({ ...node.filters, sort: node.sort, limit: 100 }),
    [node.filters, node.sort]
  );

  useEffect(() => setSearchDraft(node.filters.query), [node.filters.query]);

  const load = useCallback(
    async (cursor?: string, append = false) => {
      setLoading(true);
      try {
        const next = await projectionContext.onLoadView({ ...query, cursor });
        setResponse((current) =>
          append && current
            ? {
                ...next,
                results: mergeWorkItems(current.results, next.results),
              }
            : next
        );
        setError(undefined);
      } catch {
        setError(ppmT("canvas.work_items_view_load_error"));
      } finally {
        setLoading(false);
      }
    },
    [ppmT, projectionContext, query]
  );

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 30_000);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  const patchConfig = (
    patch: Partial<
      Pick<Extract<TPpmCanvasNode, { kind: "work_items_view" }>, "filters" | "group_by" | "layout" | "sort" | "title">
    >
  ) => updateNode(editor, shape, node, patch);

  const replaceSource = (updated: TPpmWorkItemProjection) => {
    setResponse((current) =>
      current
        ? {
            ...current,
            results: current.results.map((item) =>
              item.identity.entity_id === updated.identity.entity_id ? updated : item
            ),
          }
        : current
    );
  };

  const patchSource = async (
    source: TPpmWorkItemProjection,
    patch: Omit<TPpmWorkItemPatchRequest, "source_version">,
    optimistic?: TPpmWorkItemProjection
  ) => {
    const entityId = source.identity.entity_id;
    const previous = response;
    setBusyIds((current) => new Set(current).add(entityId));
    if (optimistic) replaceSource(optimistic);
    try {
      const updated = await projectionContext.onUpdateSource(source, patch);
      replaceSource(updated);
      setError(undefined);
    } catch {
      if (previous) setResponse(previous);
      setError(ppmT("canvas.work_item_stale"));
      void load();
    } finally {
      setBusyIds((current) => {
        const next = new Set(current);
        next.delete(entityId);
        return next;
      });
    }
  };

  const createItem = async (stateId?: string) => {
    const name = draftTitle.trim();
    if (!name) return;
    setLoading(true);
    try {
      await projectionContext.onCreateFromView({
        name,
        client_operation_id: crypto.randomUUID(),
        ...(stateId || node.filters.state_ids[0] ? { state_id: stateId ?? node.filters.state_ids[0] } : {}),
      });
      setDraftTitle("");
      await load();
    } catch {
      setError(ppmT("canvas.work_item_action_error"));
      setLoading(false);
    }
  };

  const exportView = async (format: "csv" | "markdown") => {
    try {
      await projectionContext.onExportView(format, query);
      setError(undefined);
    } catch {
      setError(ppmT("canvas.work_items_view_export_error"));
    }
  };

  const groups = groupWorkItems(node.group_by, response, ppmT);

  return (
    <div
      className="ppm-work-items-view"
      data-layout={node.layout}
      onPointerDown={stopEventPropagation}
      onWheelCapture={stopEventPropagation}
    >
      <header className="ppm-work-items-view__header">
        <div className="ppm-work-items-view__identity">
          <span>{ppmT("canvas.work_items_view")}</span>
          <input
            aria-label={ppmT("canvas.work_items_view_title")}
            disabled={readonly}
            maxLength={160}
            value={node.title}
            onChange={(event) => patchConfig({ title: event.currentTarget.value })}
            onKeyDown={stopEventPropagation}
          />
        </div>
        <div className="ppm-work-items-view__summary">
          <strong>{response?.summary.total ?? 0}</strong>
          <span>{ppmT("canvas.work_items_view_total")}</span>
          <strong>{response?.summary.progress_percent ?? 0}%</strong>
          <span>{ppmT("canvas.work_items_view_progress")}</span>
        </div>
        <div className="ppm-work-items-view__actions">
          <button
            type="button"
            data-active={node.layout === "kanban" || undefined}
            disabled={readonly}
            title={ppmT("canvas.work_items_view_kanban")}
            onClick={stopEventPropagation}
            onKeyDown={(event) =>
              runCanvasKeyboardAction(event, () => patchConfig({ group_by: "state", layout: "kanban" }))
            }
            onPointerDown={(event) =>
              runCanvasPointerAction(event, () => patchConfig({ group_by: "state", layout: "kanban" }))
            }
          >
            <Columns3 aria-hidden="true" />
          </button>
          <button
            type="button"
            data-active={node.layout === "backlog" || undefined}
            disabled={readonly}
            title={ppmT("canvas.work_items_view_backlog")}
            onClick={stopEventPropagation}
            onKeyDown={(event) => runCanvasKeyboardAction(event, () => patchConfig({ layout: "backlog" }))}
            onPointerDown={(event) => runCanvasPointerAction(event, () => patchConfig({ layout: "backlog" }))}
          >
            <ListTodo aria-hidden="true" />
          </button>
          <button
            type="button"
            data-active={node.layout === "list" || undefined}
            disabled={readonly}
            title={ppmT("canvas.work_items_view_list")}
            onClick={stopEventPropagation}
            onKeyDown={(event) => runCanvasKeyboardAction(event, () => patchConfig({ layout: "list" }))}
            onPointerDown={(event) => runCanvasPointerAction(event, () => patchConfig({ layout: "list" }))}
          >
            <List aria-hidden="true" />
          </button>
          <button
            type="button"
            title={ppmT("canvas.refresh_work_items")}
            onClick={stopEventPropagation}
            onKeyDown={(event) => runCanvasKeyboardAction(event, () => void load())}
            onPointerDown={(event) => runCanvasPointerAction(event, () => void load())}
          >
            <RefreshCw aria-hidden="true" />
          </button>
          <button
            type="button"
            title={ppmT("canvas.work_items_view_export_csv")}
            onClick={stopEventPropagation}
            onKeyDown={(event) => runCanvasKeyboardAction(event, () => void exportView("csv"))}
            onPointerDown={(event) => runCanvasPointerAction(event, () => void exportView("csv"))}
          >
            <Download aria-hidden="true" />
            <span>CSV</span>
          </button>
          <button
            type="button"
            title={ppmT("canvas.work_items_view_export_markdown")}
            onClick={stopEventPropagation}
            onKeyDown={(event) => runCanvasKeyboardAction(event, () => void exportView("markdown"))}
            onPointerDown={(event) => runCanvasPointerAction(event, () => void exportView("markdown"))}
          >
            <Download aria-hidden="true" />
            <span>MD</span>
          </button>
          {!readonly && (
            <>
              <button
                type="button"
                title={ppmT("canvas.node_duplicate")}
                onClick={stopEventPropagation}
                onKeyDown={(event) => runCanvasKeyboardAction(event, () => duplicateNode(editor, shape, node))}
                onPointerDown={(event) => runCanvasPointerAction(event, () => duplicateNode(editor, shape, node))}
              >
                <Copy aria-hidden="true" />
              </button>
              <button
                type="button"
                title={ppmT("canvas.node_remove")}
                onClick={stopEventPropagation}
                onKeyDown={(event) => runCanvasKeyboardAction(event, () => editor.deleteShape(shape.id))}
                onPointerDown={(event) => runCanvasPointerAction(event, () => editor.deleteShape(shape.id))}
              >
                <Trash2 aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      </header>

      <div className="ppm-work-items-view__filters">
        <input
          aria-label={ppmT("canvas.search_work_items")}
          disabled={readonly}
          placeholder={ppmT("canvas.search_work_items")}
          value={searchDraft}
          onChange={(event) => setSearchDraft(event.currentTarget.value)}
          onBlur={() =>
            searchDraft !== node.filters.query && patchConfig({ filters: { ...node.filters, query: searchDraft } })
          }
          onKeyDown={(event) => {
            stopEventPropagation(event);
            if (event.key === "Enter" && searchDraft !== node.filters.query)
              patchConfig({ filters: { ...node.filters, query: searchDraft } });
          }}
        />
        <select
          aria-label={ppmT("canvas.work_item_state")}
          disabled={readonly}
          value={node.filters.state_ids[0] ?? ""}
          onChange={(event) =>
            patchConfig({
              filters: { ...node.filters, state_ids: event.currentTarget.value ? [event.currentTarget.value] : [] },
            })
          }
        >
          <option value="">{ppmT("canvas.work_items_view_all_states")}</option>
          {response?.work_item_options.states.map((state) => (
            <option key={state.id} value={state.id}>
              {state.name}
            </option>
          ))}
        </select>
        <select
          aria-label={ppmT("canvas.work_item_priority")}
          disabled={readonly}
          value={node.filters.priorities[0] ?? ""}
          onChange={(event) =>
            patchConfig({
              filters: {
                ...node.filters,
                priorities: event.currentTarget.value
                  ? [event.currentTarget.value as NonNullable<TPpmWorkItemPatchRequest["priority"]>]
                  : [],
              },
            })
          }
        >
          <option value="">{ppmT("canvas.work_items_view_all_priorities")}</option>
          {response?.work_item_options.priorities.map((priority) => (
            <option key={priority} value={priority}>
              {ppmT(PRIORITY_LABELS[priority])}
            </option>
          ))}
        </select>
        <select
          aria-label={ppmT("canvas.work_items_view_group")}
          disabled={readonly}
          value={node.group_by}
          onChange={(event) =>
            patchConfig({
              group_by: event.currentTarget.value as Extract<TPpmCanvasNode, { kind: "work_items_view" }>["group_by"],
            })
          }
        >
          <option value="state">{ppmT("canvas.work_items_view_group_state")}</option>
          <option value="priority">{ppmT("canvas.work_items_view_group_priority")}</option>
          <option value="assignee">{ppmT("canvas.work_items_view_group_assignee")}</option>
          <option value="none">{ppmT("canvas.work_items_view_group_none")}</option>
        </select>
        <select
          aria-label={ppmT("canvas.work_items_view_sort")}
          disabled={readonly}
          value={node.sort}
          onChange={(event) =>
            patchConfig({
              sort: event.currentTarget.value as Extract<TPpmCanvasNode, { kind: "work_items_view" }>["sort"],
            })
          }
        >
          <option value="updated_desc">{ppmT("canvas.work_items_view_sort_updated_desc")}</option>
          <option value="created_desc">{ppmT("canvas.work_items_view_sort_created_desc")}</option>
          <option value="due_asc">{ppmT("canvas.work_items_view_sort_due_asc")}</option>
          <option value="due_desc">{ppmT("canvas.work_items_view_sort_due_desc")}</option>
        </select>
        <label>
          <input
            type="checkbox"
            checked={node.filters.include_archived}
            disabled={readonly}
            onChange={(event) =>
              patchConfig({ filters: { ...node.filters, include_archived: event.currentTarget.checked } })
            }
          />
          <span>{ppmT("canvas.work_items_view_archived")}</span>
        </label>
      </div>

      {projectionContext.canEdit && (
        <div className="ppm-work-items-view__create">
          <input
            maxLength={255}
            placeholder={ppmT("canvas.work_items_view_new_placeholder")}
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.currentTarget.value)}
            onKeyDown={(event) => {
              stopEventPropagation(event);
              if (event.key === "Enter") void createItem();
            }}
          />
          <button
            type="button"
            disabled={!draftTitle.trim() || loading}
            onClick={stopEventPropagation}
            onKeyDown={(event) => runCanvasKeyboardAction(event, () => void createItem())}
            onPointerDown={(event) => runCanvasPointerAction(event, () => void createItem())}
          >
            <Plus aria-hidden="true" />
            {ppmT("canvas.create_work_item")}
          </button>
        </div>
      )}

      {error && <p className="ppm-work-items-view__error">{error}</p>}
      {loading && !response ? (
        <div className="ppm-work-items-view__loading">
          <LoaderCircle aria-hidden="true" />
          {ppmT("canvas.work_item_loading")}
        </div>
      ) : response?.results.length === 0 ? (
        <div className="ppm-work-items-view__empty">{ppmT("canvas.work_item_empty_search")}</div>
      ) : node.layout === "list" ? (
        <WorkItemsList
          busyIds={busyIds}
          canEdit={projectionContext.canEdit}
          items={response?.results ?? []}
          onPatch={patchSource}
          options={response?.work_item_options ?? projectionContext.options}
        />
      ) : (
        <div className="ppm-work-items-view__groups" data-layout={node.layout}>
          {groups.map((group) => (
            <section
              className="ppm-work-items-view__group"
              data-drag-target={draggedId && group.stateId ? true : undefined}
              key={group.id}
              onDragOver={(event) => {
                if (draggedId && group.stateId) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                const source = response?.results.find((item) => item.identity.entity_id === draggedId);
                if (!source || !group.stateId || source.display.state?.id === group.stateId) return;
                const state = response?.work_item_options.states.find((item) => item.id === group.stateId);
                if (!state) return;
                const optimistic = { ...source, display: { ...source.display, state } };
                void patchSource(source, { state_id: group.stateId }, optimistic);
                setDraggedId(undefined);
              }}
            >
              <header>
                <span style={{ backgroundColor: group.color }} />
                <strong>{group.label}</strong>
                <small>{group.items.length}</small>
              </header>
              <div>
                {group.items.map((item) => (
                  <WorkItemViewCard
                    busy={busyIds.has(item.identity.entity_id)}
                    canEdit={projectionContext.canEdit}
                    draggable={node.layout === "kanban" && node.group_by === "state"}
                    item={item}
                    key={item.identity.entity_id}
                    onDragEnd={() => setDraggedId(undefined)}
                    onDragStart={(event) => {
                      setDraggedId(item.identity.entity_id);
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", item.identity.entity_id);
                    }}
                    onPatch={patchSource}
                    options={response?.work_item_options ?? projectionContext.options}
                  />
                ))}
              </div>
              {projectionContext.canEdit && group.stateId && (
                <button
                  type="button"
                  className="ppm-work-items-view__column-create"
                  onClick={stopEventPropagation}
                  onKeyDown={(event) => runCanvasKeyboardAction(event, () => void createItem(group.stateId))}
                  onPointerDown={(event) => runCanvasPointerAction(event, () => void createItem(group.stateId))}
                >
                  <Plus aria-hidden="true" />
                  {ppmT("canvas.work_items_view_add_to_state")}
                </button>
              )}
            </section>
          ))}
        </div>
      )}
      {response?.next_cursor && (
        <button
          type="button"
          className="ppm-work-items-view__more"
          disabled={loading}
          onClick={stopEventPropagation}
          onKeyDown={(event) =>
            runCanvasKeyboardAction(event, () => void load(response.next_cursor ?? undefined, true))
          }
          onPointerDown={(event) =>
            runCanvasPointerAction(event, () => void load(response.next_cursor ?? undefined, true))
          }
        >
          {ppmT("canvas.show_more")}
        </button>
      )}
    </div>
  );
}

function WorkItemsList({
  busyIds,
  canEdit,
  items,
  onPatch,
  options,
}: {
  busyIds: ReadonlySet<string>;
  canEdit: boolean;
  items: TPpmWorkItemProjection[];
  onPatch: (
    source: TPpmWorkItemProjection,
    patch: Omit<TPpmWorkItemPatchRequest, "source_version">,
    optimistic?: TPpmWorkItemProjection
  ) => Promise<void>;
  options: TPpmWorkItemEditOptions;
}) {
  return (
    <div className="ppm-work-items-view__list">
      {items.map((item) => (
        <WorkItemViewCard
          busy={busyIds.has(item.identity.entity_id)}
          canEdit={canEdit}
          draggable={false}
          item={item}
          key={item.identity.entity_id}
          onDragEnd={() => undefined}
          onDragStart={() => undefined}
          onPatch={onPatch}
          options={options}
        />
      ))}
    </div>
  );
}

function WorkItemViewCard({
  busy,
  canEdit,
  draggable,
  item,
  onDragEnd,
  onDragStart,
  onPatch,
  options,
}: {
  busy: boolean;
  canEdit: boolean;
  draggable: boolean;
  item: TPpmWorkItemProjection;
  onDragEnd: () => void;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onPatch: (
    source: TPpmWorkItemProjection,
    patch: Omit<TPpmWorkItemPatchRequest, "source_version">,
    optimistic?: TPpmWorkItemProjection
  ) => Promise<void>;
  options: TPpmWorkItemEditOptions;
}) {
  const ppmT = usePpmTranslation();
  const editable = canEdit && item.capabilities.update && !busy && item.display.source_status === "active";
  return (
    <div
      className="ppm-work-items-view-card"
      data-busy={busy || undefined}
      data-source-status={item.display.source_status}
      draggable={draggable && editable}
      onDragEnd={onDragEnd}
      onDragStart={onDragStart}
    >
      <div className="ppm-work-items-view-card__title">
        <span>{item.identity.identifier}</span>
        <strong>{item.display.title}</strong>
        {item.identity.source_url && (
          <a href={item.identity.source_url} onClick={stopEventPropagation} onPointerDown={stopEventPropagation}>
            <ExternalLink aria-hidden="true" />
          </a>
        )}
      </div>
      <div className="ppm-work-items-view-card__fields">
        <select
          aria-label={ppmT("canvas.work_item_state")}
          disabled={!editable}
          value={item.display.state?.id ?? ""}
          onChange={(event) => void onPatch(item, { state_id: event.currentTarget.value })}
        >
          {!item.display.state && <option value="">—</option>}
          {options.states.map((state) => (
            <option key={state.id} value={state.id}>
              {state.name}
            </option>
          ))}
        </select>
        <select
          aria-label={ppmT("canvas.work_item_priority")}
          disabled={!editable}
          value={item.display.priority}
          onChange={(event) =>
            void onPatch(item, { priority: event.currentTarget.value as TPpmWorkItemPatchRequest["priority"] })
          }
        >
          {options.priorities.map((priority) => (
            <option key={priority} value={priority}>
              {ppmT(PRIORITY_LABELS[priority])}
            </option>
          ))}
        </select>
        <input
          aria-label={ppmT("canvas.work_item_due_date")}
          disabled={!editable}
          type="date"
          value={item.display.due_date ?? ""}
          onChange={(event) => void onPatch(item, { due_date: event.currentTarget.value || null })}
        />
        <select
          multiple
          aria-label={ppmT("canvas.work_item_assignees")}
          disabled={!editable}
          value={item.display.assignees.map((assignee) => assignee.id)}
          onChange={(event) =>
            void onPatch(item, {
              assignee_ids: [...event.currentTarget.selectedOptions].map((option) => option.value),
            })
          }
        >
          {options.assignees.map((assignee) => (
            <option key={assignee.id} value={assignee.id}>
              {assignee.display_name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function mergeWorkItems(current: TPpmWorkItemProjection[], next: TPpmWorkItemProjection[]) {
  const byId = new Map(current.map((item) => [item.identity.entity_id, item]));
  for (const item of next) byId.set(item.identity.entity_id, item);
  return [...byId.values()];
}

function groupWorkItems(
  groupBy: Extract<TPpmCanvasNode, { kind: "work_items_view" }>["group_by"],
  response: TPpmWorkItemsViewResponse | undefined,
  translate: (key: TPpmTranslationKey) => string
): TWorkItemsViewGroup[] {
  if (!response) return [];
  if (groupBy === "state") {
    const states = response.work_item_options.states.map((state) => ({
      id: `state:${state.id}`,
      label: state.name,
      color: state.color,
      stateId: state.id,
      items: response.results.filter((item) => item.display.state?.id === state.id),
    }));
    const withoutState = response.results.filter((item) => !item.display.state);
    return withoutState.length
      ? [...states, { id: "state:none", label: "Без статуса", color: "#8B93A3", items: withoutState }]
      : states;
  }
  if (groupBy === "priority")
    return response.work_item_options.priorities.map((priority) => ({
      id: `priority:${priority}`,
      label: translate(PRIORITY_LABELS[priority]),
      color: priorityColor(priority),
      items: response.results.filter((item) => item.display.priority === priority),
    }));
  if (groupBy === "assignee") {
    const groups = response.work_item_options.assignees.map((assignee) => ({
      id: `assignee:${assignee.id}`,
      label: assignee.display_name,
      color: "#22D3EE",
      items: response.results.filter((item) => item.display.assignees.some((value) => value.id === assignee.id)),
    }));
    const unassigned = response.results.filter((item) => item.display.assignees.length === 0);
    return unassigned.length
      ? [...groups, { id: "assignee:none", label: "Без исполнителя", color: "#8B93A3", items: unassigned }]
      : groups;
  }
  return [{ id: "all", label: "Все задачи", color: "#22D3EE", items: response.results }];
}

type TWorkItemsViewGroup = {
  id: string;
  label: string;
  color: string;
  stateId?: string;
  items: TPpmWorkItemProjection[];
};

function priorityColor(priority: TPpmWorkItemProjection["display"]["priority"]) {
  return {
    urgent: "#F87171",
    high: "#FB923C",
    medium: "#F59E0B",
    low: "#60A5FA",
    none: "#8B93A3",
  }[priority];
}

function WorkItemProjectionCard({
  node,
  shape,
}: {
  node: Extract<TPpmCanvasNode, { kind: "work_item_ref" }>;
  shape: TPpmCanvasShape;
}) {
  const ppmT = usePpmTranslation();
  const projectionContext = useContext(PpmWorkItemProjectionContext);
  const binding = projectionContext.bindingsByShapeId.get(shape.id);
  const error = projectionContext.errorsByShapeId.get(shape.id);
  const grammarV2 = usePpmCanvasGrammarV2();
  const { currentLocale } = useTranslation();

  if (!binding || binding.entity_type !== "work_item") {
    return (
      <div className="ppm-work-item-card ppm-work-item-card--loading">
        <span className="ppm-canvas-node__kind">{ppmT("canvas.work_item")}</span>
        <strong>{ppmT("canvas.work_item_loading")}</strong>
        <span>{node.binding.entity_id}</span>
        <button type="button" onClick={projectionContext.onRefresh} onPointerDown={stopEventPropagation}>
          <RefreshCw aria-hidden="true" />
          {ppmT("canvas.refresh_work_items")}
        </button>
      </div>
    );
  }

  const source = binding.source;
  const { display, identity } = source;
  const canUpdate =
    projectionContext.canEdit &&
    source.capabilities.update &&
    Boolean(source.source_version) &&
    !projectionContext.pendingWorkItemIds.has(binding.entity_id);
  const assigneeIds = display.assignees.map((assignee) => assignee.id);

  return (
    <div
      className={grammarV2 ? "ppm-work-item-card ppm-live-card" : "ppm-work-item-card"}
      data-source-status={display.source_status}
    >
      {grammarV2 ? (
        <>
          <LiveSourceHeader
            icon={SquareCheck}
            identifier={identity.identifier}
            source="tasks"
            sourceLabel={ppmT(LIVE_SOURCE_LABEL_KEYS.tasks)}
          />
          <strong
            className="ppm-live-card__title"
            data-narrow={shouldNarrowTitle(display.title, shape.props.w) || undefined}
          >
            {display.title}
          </strong>
        </>
      ) : (
        <header>
          <div>
            <span className="ppm-canvas-node__kind">{identity.identifier ?? ppmT("canvas.work_item")}</span>
            <strong>{display.title}</strong>
          </div>
          <span className="ppm-work-item-card__source">PPM</span>
        </header>
      )}

      {display.source_status === "active" ? (
        <div className="ppm-work-item-card__fields">
          <label>
            <span>{ppmT("canvas.work_item_state")}</span>
            <select
              aria-label={ppmT("canvas.work_item_state")}
              disabled={!canUpdate}
              value={display.state?.id ?? ""}
              onChange={(event) =>
                projectionContext.onUpdate(shape.id, binding, { state_id: event.currentTarget.value })
              }
              onKeyDown={stopEventPropagation}
              onPointerDown={stopEventPropagation}
            >
              {!display.state && <option value="">—</option>}
              {projectionContext.options.states.map((state) => (
                <option key={state.id} value={state.id}>
                  {grammarV2 ? (getPpmStateDisplayName(state, currentLocale) ?? state.name) : state.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{ppmT("canvas.work_item_priority")}</span>
            <select
              aria-label={ppmT("canvas.work_item_priority")}
              disabled={!canUpdate}
              value={display.priority}
              onChange={(event) =>
                projectionContext.onUpdate(shape.id, binding, {
                  priority: event.currentTarget.value as TPpmWorkItemPatchRequest["priority"],
                })
              }
              onKeyDown={stopEventPropagation}
              onPointerDown={stopEventPropagation}
            >
              {projectionContext.options.priorities.map((priority) => (
                <option key={priority} value={priority}>
                  {ppmT(PRIORITY_LABELS[priority])}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{ppmT("canvas.work_item_due_date")}</span>
            <input
              aria-label={ppmT("canvas.work_item_due_date")}
              disabled={!canUpdate}
              type="date"
              value={display.due_date ?? ""}
              onChange={(event) =>
                projectionContext.onUpdate(shape.id, binding, { due_date: event.currentTarget.value || null })
              }
              onKeyDown={stopEventPropagation}
              onPointerDown={stopEventPropagation}
            />
          </label>
          <label className="ppm-work-item-card__assignees">
            <span>{ppmT("canvas.work_item_assignees")}</span>
            <select
              multiple
              aria-label={ppmT("canvas.work_item_assignees")}
              disabled={!canUpdate}
              value={assigneeIds}
              onChange={(event) =>
                projectionContext.onUpdate(shape.id, binding, {
                  assignee_ids: [...event.currentTarget.selectedOptions].map((option) => option.value),
                })
              }
              onKeyDown={stopEventPropagation}
              onPointerDown={stopEventPropagation}
            >
              {projectionContext.options.assignees.map((assignee) => (
                <option key={assignee.id} value={assignee.id}>
                  {assignee.display_name}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <p className="ppm-work-item-card__inactive">
          {ppmT(display.source_status === "archived" ? "canvas.work_item_archived" : "canvas.work_item_deleted")}
        </p>
      )}

      {error && <p className="ppm-work-item-card__error">{error}</p>}
      <footer>
        {grammarV2 ? (
          <>
            <span className="ppm-live-card__meta">
              {display.assignees.map((assignee) => assignee.display_name).join(", ") || ppmT("canvas.unassigned")}
            </span>
            {identity.source_url && (
              <LiveOpenLink
                href={identity.source_url}
                label={fillCanvasTemplate(ppmT(LIVE_SOURCE_OPEN_KEYS.tasks), {
                  name: identity.identifier ?? display.title,
                })}
              />
            )}
          </>
        ) : (
          identity.source_url && (
            <a href={identity.source_url} onClick={stopEventPropagation} onPointerDown={stopEventPropagation}>
              <ExternalLink aria-hidden="true" />
              {ppmT("canvas.open_work_item")}
            </a>
          )
        )}
        {projectionContext.canEdit && (
          <button
            type="button"
            aria-label={grammarV2 ? ppmT("canvas.remove_projection") : undefined}
            className={grammarV2 ? "ppm-live-card__remove" : undefined}
            disabled={projectionContext.pendingWorkItemIds.has(binding.entity_id)}
            title={grammarV2 ? ppmT("canvas.remove_projection") : undefined}
            onClick={() => projectionContext.onRemove(shape, binding)}
            onPointerDown={stopEventPropagation}
          >
            <Trash2 aria-hidden="true" />
            {!grammarV2 && ppmT("canvas.remove_projection")}
          </button>
        )}
      </footer>
    </div>
  );
}

function ContentProjectionCard({
  node,
  shape,
}: {
  node: Extract<TPpmCanvasNode, { kind: "page_ref" | "attachment_ref" | "vault_file_ref" }>;
  shape: TPpmCanvasShape;
}) {
  const ppmT = usePpmTranslation();
  const projectionContext = useContext(PpmWorkItemProjectionContext);
  const resolved = projectionContext.bindingsByShapeId.get(shape.id);
  const binding = isContentProjectionBinding(resolved) ? resolved : undefined;
  const fallbackTitle = node.title;
  const fallbackUrl = node.source_url;
  const grammarV2 = usePpmCanvasGrammarV2();

  if (!binding) {
    return (
      <div className="ppm-work-item-card ppm-work-item-card--loading">
        <span className="ppm-canvas-node__kind">
          {ppmT(CONTENT_SOURCE_LABELS[node.binding?.entity_type ?? "vault_file"])}
        </span>
        <strong>{fallbackTitle}</strong>
        <button type="button" onClick={projectionContext.onRefresh} onPointerDown={stopEventPropagation}>
          <RefreshCw aria-hidden="true" />
          {ppmT("canvas.refresh_sources")}
        </button>
      </div>
    );
  }

  const { display, identity } = binding.source;
  const sourceLabel = CONTENT_SOURCE_LABELS[binding.entity_type];
  const liveSource = liveSourceForEntity(binding.entity_type);
  // «PDF · v3»; an unknown version is hidden instead of «v—» (the header already names the source).
  const liveMeta = liveCardMeta(display.extension, binding.source_version);
  return (
    <div
      className={
        grammarV2
          ? "ppm-canvas-node__content ppm-canvas-node__content--vault ppm-live-card"
          : "ppm-canvas-node__content ppm-canvas-node__content--vault"
      }
      data-source-status={display.source_status}
    >
      {grammarV2 ? (
        <LiveSourceHeader
          icon={binding.entity_type === "page" ? FileText : binding.entity_type === "attachment" ? Paperclip : Archive}
          identifier={display.extension ? display.extension.slice(1).toUpperCase() : null}
          source={liveSource}
          sourceLabel={ppmT(LIVE_SOURCE_LABEL_KEYS[liveSource])}
        />
      ) : (
        <span className="ppm-canvas-node__kind">{ppmT(sourceLabel)}</span>
      )}
      <strong
        className={grammarV2 ? "ppm-live-card__title" : "ppm-canvas-node__vault-title"}
        data-narrow={grammarV2 && shouldNarrowTitle(display.title || fallbackTitle, shape.props.w) ? true : undefined}
      >
        {display.title || fallbackTitle}
      </strong>
      {display.excerpt && <p>{display.excerpt}</p>}
      {grammarV2 ? (
        // Kept even when empty: the card grid (canvas-v2.css .ppm-live-card) places rows by position.
        <span className="ppm-canvas-node__vault-meta ppm-live-card__version">{liveMeta}</span>
      ) : (
        <span className="ppm-canvas-node__vault-meta">
          {display.extension ? `${display.extension.slice(1).toUpperCase()} · ` : ""}
          {`${ppmT("canvas.source_version")} ${binding.source_version ?? "—"}`}
        </span>
      )}
      {display.source_status === "deleted" && <p>{ppmT("canvas.source_unavailable")}</p>}
      <footer>
        {(identity.source_url || fallbackUrl) &&
          display.source_status !== "deleted" &&
          (grammarV2 ? (
            <LiveOpenLink
              href={identity.source_url ?? fallbackUrl}
              label={fillCanvasTemplate(ppmT(LIVE_SOURCE_OPEN_KEYS[liveSource]), {
                name: `«${display.title || fallbackTitle}»`,
              })}
            />
          ) : (
            <a
              className="ppm-canvas-node__vault-link"
              href={identity.source_url ?? fallbackUrl}
              onClick={stopEventPropagation}
              onKeyDown={stopEventPropagation}
              onPointerDown={stopEventPropagation}
            >
              <ExternalLink aria-hidden="true" />
              {ppmT(CONTENT_SOURCE_OPEN_LABELS[binding.entity_type])}
            </a>
          ))}
        {projectionContext.canEdit && (
          <button
            type="button"
            aria-label={grammarV2 ? ppmT("canvas.remove_projection") : undefined}
            className={grammarV2 ? "ppm-live-card__remove" : undefined}
            disabled={projectionContext.pendingWorkItemIds.has(binding.entity_id)}
            title={grammarV2 ? ppmT("canvas.remove_projection") : undefined}
            onClick={() => projectionContext.onRemove(shape, binding)}
            onPointerDown={stopEventPropagation}
          >
            <Trash2 aria-hidden="true" />
            {!grammarV2 && ppmT("canvas.remove_projection")}
          </button>
        )}
      </footer>
    </div>
  );
}

function MediaProjectionCard({
  editor,
  node,
  shape,
}: {
  editor: Editor;
  node: Extract<TPpmCanvasNode, { kind: "pdf" | "image" | "reference" }>;
  shape: TPpmCanvasShape;
}) {
  const ppmT = usePpmTranslation();
  const projectionContext = useContext(PpmWorkItemProjectionContext);
  const resolved = projectionContext.bindingsByShapeId.get(shape.id);
  const binding = isContentProjectionBinding(resolved) ? resolved : undefined;
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const [previewError, setPreviewError] = useState(false);
  const visible = useLazyPreview(editor, shape.id);
  const previewUrl = binding?.source.display.preview_url;
  const grammarV2 = usePpmCanvasGrammarV2();
  useEffect(() => setPreviewError(false), [previewUrl]);

  if (!binding) {
    return (
      <div className="ppm-work-item-card ppm-work-item-card--loading">
        <span className="ppm-canvas-node__kind">{ppmT(MEDIA_KIND_LABELS[node.kind])}</span>
        <strong>{node.title}</strong>
        <button type="button" onClick={projectionContext.onRefresh} onPointerDown={stopEventPropagation}>
          <RefreshCw aria-hidden="true" />
          {ppmT("canvas.refresh_sources")}
        </button>
      </div>
    );
  }

  const { display, identity } = binding.source;
  const unavailable = display.source_status === "deleted" || display.source_status === "quarantined";
  const liveSource = liveSourceForEntity(binding.entity_type);
  return (
    <div
      className="ppm-canvas-media"
      data-media-kind={node.kind}
      data-preview-url={previewUrl ?? undefined}
      data-source-status={display.source_status}
    >
      <header>
        {grammarV2 ? (
          <LiveSourceHeader
            icon={binding.entity_type === "attachment" ? Paperclip : Archive}
            identifier={display.extension?.slice(1).toUpperCase() || null}
            source={liveSource}
            sourceLabel={ppmT(LIVE_SOURCE_LABEL_KEYS[liveSource])}
          />
        ) : (
          <span className="ppm-canvas-node__kind">{ppmT(MEDIA_KIND_LABELS[node.kind])}</span>
        )}
        <strong>{display.title || node.title}</strong>
        <small>
          {display.extension?.slice(1).toUpperCase() || display.mime_type} · {formatMediaSize(display.size_bytes)}
          {/* v2 hides an unknown version instead of «v—» (as liveCardMeta); v1 keeps the wave 0 line. */}
          {grammarV2 && !binding.source_version?.trim() ? null : <> · v{binding.source_version ?? "—"}</>}
        </small>
      </header>
      <div className="ppm-canvas-media__preview">
        {!visible && <span>{ppmT("canvas.preview_waiting")}</span>}
        {visible && unavailable && (
          <span>
            {ppmT(display.source_status === "quarantined" ? "canvas.source_quarantined" : "canvas.source_unavailable")}
          </span>
        )}
        {visible && !unavailable && previewError && <span>{ppmT("canvas.preview_error")}</span>}
        {visible && !unavailable && !previewError && node.kind === "image" && previewUrl && (
          <img
            alt={node.alt || display.title}
            loading="lazy"
            referrerPolicy="no-referrer"
            src={previewUrl}
            onError={() => setPreviewError(true)}
          />
        )}
        {visible && !unavailable && !previewError && node.kind === "pdf" && previewUrl && (
          <iframe
            loading="lazy"
            referrerPolicy="no-referrer"
            sandbox=""
            src={previewUrl}
            title={display.title}
            onError={() => setPreviewError(true)}
          />
        )}
        {visible && !unavailable && node.kind === "reference" && (
          <span>{display.excerpt || ppmT("canvas.reference_preview")}</span>
        )}
      </div>
      {projectionContext.errorsByShapeId.get(shape.id) && (
        <p className="ppm-work-item-card__error">{projectionContext.errorsByShapeId.get(shape.id)}</p>
      )}
      <footer>
        {identity.source_url &&
          !unavailable &&
          (grammarV2 ? (
            <LiveOpenLink
              href={identity.source_url}
              label={fillCanvasTemplate(ppmT(LIVE_SOURCE_OPEN_KEYS[liveSource]), {
                name: `«${display.title || node.title}»`,
              })}
            />
          ) : (
            <a
              href={identity.source_url}
              onClick={stopEventPropagation}
              onKeyDown={stopEventPropagation}
              onPointerDown={stopEventPropagation}
            >
              <ExternalLink aria-hidden="true" />
              {ppmT("canvas.open_source")}
            </a>
          ))}
        {projectionContext.canEdit && binding.entity_type === "vault_file" && !unavailable && (
          <>
            <button
              type="button"
              disabled={projectionContext.pendingWorkItemIds.has(binding.entity_id)}
              onClick={() => replaceInputRef.current?.click()}
              onPointerDown={stopEventPropagation}
            >
              <RefreshCw aria-hidden="true" />
              {ppmT("canvas.replace_file")}
            </button>
            <input
              ref={replaceInputRef}
              hidden
              type="file"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) projectionContext.onReplaceVaultFile(shape, binding, file);
                event.currentTarget.value = "";
              }}
            />
          </>
        )}
        {projectionContext.canEdit && (
          <button
            type="button"
            aria-label={grammarV2 ? ppmT("canvas.remove_projection") : undefined}
            className={grammarV2 ? "ppm-live-card__remove" : undefined}
            disabled={projectionContext.pendingWorkItemIds.has(binding.entity_id)}
            title={grammarV2 ? ppmT("canvas.remove_projection") : undefined}
            onClick={() => projectionContext.onRemove(shape, binding)}
            onPointerDown={stopEventPropagation}
          >
            <Trash2 aria-hidden="true" />
            {!grammarV2 && ppmT("canvas.remove_projection")}
          </button>
        )}
      </footer>
    </div>
  );
}

function DiagramNode({ node, shape }: { node: Extract<TPpmCanvasNode, { kind: "diagram" }>; shape: TPpmCanvasShape }) {
  const editor = useEditor();
  const ppmT = usePpmTranslation();
  const projectionContext = useContext(PpmWorkItemProjectionContext);
  const [draft, setDraft] = useState(node.source);
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [renderError, setRenderError] = useState(false);

  useEffect(() => setDraft(node.source), [node.source]);
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    const render = async () => {
      if (!isPpmMermaidSourceSafe(node.source)) {
        setRenderError(true);
        return;
      }
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({ securityLevel: "strict", startOnLoad: false, suppressErrorRendering: true });
        const rendered = await mermaid.render(`ppm-mermaid-${crypto.randomUUID()}`, node.source);
        if (!active) return;
        objectUrl = URL.createObjectURL(new Blob([rendered.svg], { type: "image/svg+xml" }));
        setPreviewUrl(objectUrl);
        setRenderError(false);
      } catch {
        if (active) setRenderError(true);
      }
    };
    void render();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [node.source]);

  const commit = () => {
    if (!projectionContext.canEdit || draft === node.source || !isPpmMermaidSourceSafe(draft)) return;
    updateNode(editor, shape, node, { source: draft });
  };

  return (
    <div className="ppm-canvas-diagram">
      <header>
        <span className="ppm-canvas-node__kind">{ppmT("canvas.diagram")}</span>
        <strong>{node.title}</strong>
      </header>
      <div className="ppm-canvas-diagram__preview">
        {previewUrl && !renderError ? (
          <img alt={node.title} src={previewUrl} />
        ) : (
          <span>{ppmT("canvas.diagram_error")}</span>
        )}
      </div>
      {projectionContext.canEdit && (
        <textarea
          aria-label={ppmT("canvas.diagram_source")}
          spellCheck={false}
          value={draft}
          onBlur={commit}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onPointerDown={stopEventPropagation}
        />
      )}
      {!isPpmMermaidSourceSafe(draft) && <p>{ppmT("canvas.diagram_unsafe")}</p>}
    </div>
  );
}

function DeckNode({ node, shape }: { node: Extract<TPpmCanvasNode, { kind: "deck" }>; shape: TPpmCanvasShape }) {
  const editor = useEditor();
  const ppmT = usePpmTranslation();
  const projectionContext = useContext(PpmWorkItemProjectionContext);
  const index = Math.min(node.active_slide, node.slides.length - 1);
  const slide = node.slides[index];
  const setIndex = (next: number) => updateNode(editor, shape, node, { active_slide: next });
  const patchSlide = (patch: Partial<(typeof node.slides)[number]>) =>
    updateNode(editor, shape, node, {
      slides: node.slides.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
    });

  return (
    <div className="ppm-canvas-deck">
      <header>
        <span className="ppm-canvas-node__kind">{ppmT("canvas.deck")}</span>
        <strong>{node.title}</strong>
        <small>
          {index + 1} / {node.slides.length}
        </small>
      </header>
      <article>
        {projectionContext.canEdit ? (
          <>
            <input
              maxLength={200}
              value={slide.title}
              onChange={(event) => patchSlide({ title: event.currentTarget.value })}
              onPointerDown={stopEventPropagation}
            />
            <textarea
              maxLength={10_000}
              value={slide.body}
              onChange={(event) => patchSlide({ body: event.currentTarget.value })}
              onPointerDown={stopEventPropagation}
            />
          </>
        ) : (
          <>
            <h3>{slide.title}</h3>
            <p>{slide.body}</p>
          </>
        )}
      </article>
      <footer>
        <button
          type="button"
          disabled={index === 0}
          onClick={() => setIndex(index - 1)}
          onPointerDown={stopEventPropagation}
        >
          ← {ppmT("canvas.previous_slide")}
        </button>
        <button
          type="button"
          disabled={index >= node.slides.length - 1}
          onClick={() => setIndex(index + 1)}
          onPointerDown={stopEventPropagation}
        >
          {ppmT("canvas.next_slide")} →
        </button>
        {projectionContext.canEdit && (
          <button
            type="button"
            onClick={() =>
              updateNode(editor, shape, node, {
                active_slide: node.slides.length,
                slides: [...node.slides, { id: crypto.randomUUID(), title: ppmT("canvas.new_slide"), body: "" }],
              })
            }
            onPointerDown={stopEventPropagation}
          >
            <Plus aria-hidden="true" /> {ppmT("canvas.add_slide")}
          </button>
        )}
      </footer>
    </div>
  );
}

function useLazyPreview(editor: Editor, shapeId: TPpmCanvasShape["id"]) {
  const [visible, setVisible] = useState(false);
  const nearViewport = useValue(
    `ppm canvas media preview ${shapeId}`,
    () => {
      const shapeBounds = editor.getShapePageBounds(shapeId);
      if (!shapeBounds) return false;
      const pageMargin = 240 / Math.max(editor.getZoomLevel(), 0.05);
      return editor.getViewportPageBounds().clone().expandBy(pageMargin).collides(shapeBounds);
    },
    [editor, shapeId]
  );

  useEffect(() => {
    if (nearViewport) setVisible(true);
  }, [nearViewport]);

  return visible;
}

const MEDIA_KIND_LABELS = {
  image: "canvas.image",
  pdf: "canvas.pdf",
  reference: "canvas.reference",
} as const satisfies Record<"image" | "pdf" | "reference", TPpmTranslationKey>;

function formatMediaSize(bytes: number) {
  if (bytes < 1_024) return `${bytes} Б`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1_024)} КБ`;
  return `${(bytes / 1_048_576).toFixed(1)} МБ`;
}

const CONTENT_SOURCE_LABELS = {
  page: "canvas.page",
  attachment: "canvas.attachment",
  vault_file: "canvas.vault_file",
} as const satisfies Record<TPpmCanvasContentBinding["entity_type"], TPpmTranslationKey>;

const CONTENT_SOURCE_OPEN_LABELS = {
  page: "canvas.open_page",
  attachment: "canvas.open_attachment",
  vault_file: "canvas.open_vault",
} as const satisfies Record<TPpmCanvasContentBinding["entity_type"], TPpmTranslationKey>;

function runCanvasPointerAction(event: PointerEvent<HTMLButtonElement>, action: () => void) {
  event.stopPropagation();
  if (event.button === 0) action();
}

function runCanvasKeyboardAction(event: KeyboardEvent<HTMLButtonElement>, action: () => void) {
  event.stopPropagation();
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  action();
}

function updateNode<TNode extends TPpmCanvasOwnedNode>(
  editor: Editor,
  shape: TPpmCanvasShape,
  node: TNode,
  patch: Partial<Omit<TNode, "author_id" | "created_at" | "kind" | "schema_version">>
) {
  editor.updateShape<TPpmCanvasShape>({
    id: shape.id,
    type: shape.type,
    props: { node: serializePpmCanvasNode(updatePpmCanvasNode(node, patch)) },
  });
}
