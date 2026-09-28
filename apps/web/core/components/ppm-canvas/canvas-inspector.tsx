import { useId, type KeyboardEvent } from "react";
import { ArrowLeft, ArrowRight, ArrowUpRight, SquareCheck, X } from "lucide-react";
import { useValue, type Editor, type TLShapeId } from "tldraw";
import {
  parseSerializedPpmCanvasNode,
  type TPpmCanvasBinding,
  type TPpmCanvasSemanticEdge,
  type TPpmCanvasWorkItemBinding,
  type TPpmWorkItemEditOptions,
  type TPpmWorkItemPatchRequest,
} from "@ppm/canvas";
import { useTranslation } from "@plane/i18n";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { getPpmStateDisplayName } from "@/lib/ppm-design";
import { PpmAssigneePicker } from "./canvas-assignee-picker";
import { canvasNodeTitle, fillCanvasTemplate, formatDueDate, formatDueDateRelative } from "./canvas-grammar";
import { LiveGlyph } from "./live-card";
import { SEMANTIC_EDGE_STYLE, SEMANTIC_RELATION_LABELS, semanticLinksForShape } from "./semantic-edge-style";
import { PPM_CANVAS_SHAPE_TYPE, PRIORITY_LABELS, type TPpmCanvasShape } from "./shape";

type TPatch = Omit<TPpmWorkItemPatchRequest, "source_version">;

type TPpmCanvasInspectorProps = {
  bindingsByShapeId: ReadonlyMap<string, TPpmCanvasBinding>;
  canEdit: boolean;
  edges: readonly TPpmCanvasSemanticEdge[];
  editor: Editor;
  errorsByShapeId: ReadonlyMap<string, string>;
  onOpenLinks: () => void;
  onUpdate: (shapeId: string, binding: TPpmCanvasWorkItemBinding, patch: TPatch) => void;
  options: TPpmWorkItemEditOptions;
  pendingWorkItemIds: ReadonlySet<string>;
};

// R14: a floating panel under the "Board" pill, rendered as a sibling of <Tldraw> (plain DOM, reachable by mouse and
// keyboard). Only a single selected live work-item card has an inspector in wave 1; cards keep inline editing (R4).
export function PpmCanvasInspector(props: TPpmCanvasInspectorProps) {
  const { bindingsByShapeId, editor } = props;
  const shapeId = useValue(
    "ppm canvas inspected shape",
    () => {
      const only = editor.getOnlySelectedShape();
      return only?.type === PPM_CANVAS_SHAPE_TYPE ? only.id : undefined;
    },
    [editor]
  );
  const binding = shapeId ? bindingsByShapeId.get(shapeId) : undefined;
  if (!shapeId || !binding || binding.entity_type !== "work_item") return null;
  return <WorkItemInspector {...props} binding={binding} shapeId={shapeId} />;
}

function WorkItemInspector({
  binding,
  bindingsByShapeId,
  canEdit,
  edges,
  editor,
  errorsByShapeId,
  onOpenLinks,
  onUpdate,
  options,
  pendingWorkItemIds,
  shapeId,
}: TPpmCanvasInspectorProps & { binding: TPpmCanvasWorkItemBinding; shapeId: TLShapeId }) {
  const ppmT = usePpmTranslation();
  const { currentLocale } = useTranslation();
  const fieldId = useId();
  const { display, identity } = binding.source;
  const editable = canEdit && binding.source.capabilities.update && display.source_status === "active";
  const pending = pendingWorkItemIds.has(binding.entity_id) || !binding.source.source_version;
  const links = semanticLinksForShape(edges, shapeId);
  const error = errorsByShapeId.get(shapeId);
  const update = (patch: TPatch) => onUpdate(shapeId, binding, patch);
  const close = () => {
    editor.selectNone();
    editor.getContainer().focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.code !== "Escape") return;
    event.stopPropagation();
    close();
  };
  // «Живая карточка · ROBOT-12»: several boards can each show an inspector, so the region names its task.
  const regionLabel = identity.identifier
    ? fillCanvasTemplate(ppmT("canvas.inspector_label"), { identifier: identity.identifier })
    : ppmT("canvas.live_card");

  return (
    <section className="ppm-canvas-inspector" aria-label={regionLabel} onKeyDown={onKeyDown}>
      <header className="ppm-canvas-inspector__header">
        <LiveGlyph />
        <strong>{ppmT("canvas.live_card")}</strong>
        <button
          type="button"
          aria-label={ppmT("canvas.inspector_close")}
          title={ppmT("canvas.inspector_close")}
          onClick={close}
        >
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="ppm-canvas-inspector__body">
        <p className="ppm-canvas-inspector__source">
          <span>{ppmT("canvas.inspector_source")}</span>
          <SquareCheck aria-hidden="true" />
          <strong>{ppmT("project.tasks")}</strong>
          {identity.identifier && <span className="ppm-canvas-inspector__id">· {identity.identifier}</span>}
        </p>
        <h3 className="ppm-canvas-inspector__title">{display.title}</h3>
        {identity.source_url && (
          <a className="ppm-canvas-inspector__open" href={identity.source_url}>
            <ArrowUpRight aria-hidden="true" />
            {ppmT("canvas.open_work_item")}
          </a>
        )}
        <p className="ppm-canvas-inspector__hint">{ppmT("canvas.inspector_hint")}</p>
        {error && (
          <p className="ppm-canvas-inspector__error" role="status">
            {error}
          </p>
        )}
      </div>
      <dl className="ppm-canvas-inspector__fields">
        <div>
          <dt>
            <label htmlFor={`${fieldId}-state`}>{ppmT("canvas.work_item_state")}</label>
          </dt>
          <dd>
            {editable ? (
              <select
                id={`${fieldId}-state`}
                disabled={pending}
                value={display.state?.id ?? ""}
                onChange={(event) => update({ state_id: event.currentTarget.value })}
              >
                {!display.state && <option value="">—</option>}
                {/* R11: default states in the UI language; the option values stay the state ids. */}
                {options.states.map((state) => (
                  <option key={state.id} value={state.id}>
                    {getPpmStateDisplayName(state, currentLocale) ?? state.name}
                  </option>
                ))}
              </select>
            ) : (
              <span id={`${fieldId}-state`}>{getPpmStateDisplayName(display.state, currentLocale) ?? "—"}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>
            <label htmlFor={`${fieldId}-priority`}>{ppmT("canvas.work_item_priority")}</label>
          </dt>
          <dd>
            {editable ? (
              <select
                id={`${fieldId}-priority`}
                disabled={pending}
                value={display.priority}
                onChange={(event) => update({ priority: event.currentTarget.value as TPatch["priority"] })}
              >
                {options.priorities.map((priority) => (
                  <option key={priority} value={priority}>
                    {ppmT(PRIORITY_LABELS[priority])}
                  </option>
                ))}
              </select>
            ) : (
              <span id={`${fieldId}-priority`}>{ppmT(PRIORITY_LABELS[display.priority])}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>
            <label htmlFor={`${fieldId}-due`}>{ppmT("canvas.work_item_due_date")}</label>
          </dt>
          <dd>
            {editable ? (
              <input
                id={`${fieldId}-due`}
                disabled={pending}
                type="date"
                value={display.due_date ?? ""}
                onChange={(event) => update({ due_date: event.currentTarget.value || null })}
              />
            ) : (
              <span id={`${fieldId}-due`}>
                {display.due_date ? formatDueDate(display.due_date, currentLocale) : "—"}
              </span>
            )}
            {display.due_date && (
              <small className="ppm-canvas-inspector__relative">
                {formatDueDateRelative(display.due_date, currentLocale)}
              </small>
            )}
          </dd>
        </div>
        <div>
          <dt>
            <label htmlFor={`${fieldId}-assignees`}>{ppmT("canvas.work_item_assignees")}</label>
          </dt>
          <dd>
            {/* G2.1 C: аватарки и выпадающий список (портал) вместо нативного множественного списка; без прав — только
                аватарки */}
            <PpmAssigneePicker
              id={`${fieldId}-assignees`}
              assignees={display.assignees}
              busy={pendingWorkItemIds.has(binding.entity_id)}
              canEdit={editable && Boolean(binding.source.source_version)}
              options={options.assignees}
              onChange={(assignee_ids) => update({ assignee_ids })}
            />
          </dd>
        </div>
      </dl>
      <div className="ppm-canvas-inspector__links">
        <header>
          <strong>{ppmT("canvas.inspector_links")}</strong>
          <span>· {links.length}</span>
          <button type="button" onClick={onOpenLinks}>
            {ppmT("canvas.inspector_all_links")}
          </button>
        </header>
        {links.length === 0 ? (
          <p>{ppmT("canvas.inspector_no_links")}</p>
        ) : (
          <ul>
            {links.map((link) => {
              const other = shapeTitle(editor, bindingsByShapeId, link.otherShapeId, ppmT("canvas.untitled"));
              return (
                <li key={link.edge.edge_id}>
                  <button
                    type="button"
                    aria-label={fillCanvasTemplate(ppmT("canvas.inspector_focus_node"), { title: other })}
                    onClick={() => {
                      editor.select(link.otherShapeId as TLShapeId);
                      editor.zoomToSelection({ animation: { duration: 180 } });
                    }}
                  >
                    {link.direction === "out" ? <ArrowRight aria-hidden="true" /> : <ArrowLeft aria-hidden="true" />}
                    <span
                      className="ppm-canvas-inspector__relation"
                      data-tone={SEMANTIC_EDGE_STYLE[link.edge.relation_type].tone}
                    >
                      {ppmT(SEMANTIC_RELATION_LABELS[link.edge.relation_type])}
                    </span>
                    <span className="ppm-canvas-inspector__other">{other}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

// A linked card's name; «Без названия» (never the raw tldraw id «shape:…») when it has none.
function shapeTitle(
  editor: Editor,
  bindings: ReadonlyMap<string, TPpmCanvasBinding>,
  shapeId: string,
  untitled: string
): string {
  const binding = bindings.get(shapeId);
  if (binding?.entity_type === "work_item") {
    return canvasNodeTitle([binding.source.identity.identifier, binding.source.display.title], untitled);
  }
  if (binding) return canvasNodeTitle([binding.source.display.title], untitled);
  const shape = editor.getShape<TPpmCanvasShape>(shapeId as TLShapeId);
  if (!shape || shape.type !== PPM_CANVAS_SHAPE_TYPE) return untitled;
  const parsed = parseSerializedPpmCanvasNode(shape.props.node);
  const title =
    (parsed.status === "valid" || parsed.status === "migrated") &&
    "title" in parsed.node &&
    typeof parsed.node.title === "string"
      ? parsed.node.title
      : null;
  return canvasNodeTitle([title], untitled);
}
