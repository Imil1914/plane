// AF2.1 F2: the Canvas rail exactly as at the end of UX1.1 (snapshot 201ab5f4, workspace.tsx:827-1060 and
// RailButton/RailSectionLabel :1542-1586), extracted verbatim with renamed bindings. Облик v1 renders only this rail;
// under v2 `canvas-rail.tsx` (line R) replaces it. Do not add AF2.1 features here: v1 must stay «как в конце UX1.1».
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  ChevronLeft,
  ChevronRight,
  Code2,
  Columns3,
  FileText,
  Focus,
  Frame,
  GitFork,
  Group,
  LayoutGrid,
  Link,
  ListChecks,
  ListPlus,
  Menu,
  Network,
  Presentation,
  Redo2,
  StickyNote,
  Table2,
  Undo2,
  Workflow,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import { PPM_BRAND } from "@ppm/brand";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { isCanvasCommandAllowedReadOnly } from "./board-workspace-state";
import type { TPpmCanvasCommand } from "./commands";

export type TPpmCanvasRailProps = {
  /** tldraw tool id of the active board ("select", "arrow", …). */
  activeTool?: string;
  /** capabilities.edit — the project role may edit this Canvas. */
  canEdit: boolean;
  designV2: boolean;
  /** activeBoardEditReady — the active board is loaded, editable and not blocked. */
  editReady: boolean;
  expanded: boolean;
  onRunCommand: (command: TPpmCanvasCommand) => void;
  onToggleBoards: () => void;
  onToggleExpanded: () => void;
};

export function PpmCanvasLegacyRail({
  activeTool,
  canEdit,
  designV2,
  editReady,
  expanded,
  onRunCommand,
  onToggleBoards,
  onToggleExpanded,
}: TPpmCanvasRailProps) {
  const ppmT = usePpmTranslation();
  return (
    <aside className="ppm-canvas-rail" aria-label={ppmT("canvas.toolbar")}>
      <button
        type="button"
        className="ppm-canvas-rail__brand"
        title={ppmT(expanded ? "canvas.collapse_panel" : "canvas.expand_panel")}
        aria-label={ppmT(expanded ? "canvas.collapse_panel" : "canvas.expand_panel")}
        onClick={() => onToggleExpanded()}
      >
        <img src={PPM_BRAND.assets.mark} alt="" aria-hidden="true" />
        {expanded && <strong>PPM</strong>}
        {expanded ? <ChevronLeft aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
      </button>
      <RailSectionLabel expanded={expanded} label={ppmT("canvas.navigation")} />
      <RailButton
        pressed={activeTool === "select"}
        expanded={expanded}
        icon={LayoutGrid}
        label={ppmT("canvas.canvas")}
        onClick={() => onRunCommand("select")}
      />
      <RailButton expanded={expanded} icon={Menu} label={ppmT("canvas.boards")} onClick={() => onToggleBoards()} />
      <RailSectionLabel expanded={expanded} label={ppmT("canvas.nodes")} />
      {canEdit && (
        <>
          <RailButton
            disabled={!editReady}
            expanded={expanded}
            icon={StickyNote}
            label={ppmT("canvas.add_note")}
            shortcut="⇧N"
            onClick={() => onRunCommand("add-note")}
          />
          <RailButton
            disabled={!editReady}
            expanded={expanded}
            icon={FileText}
            label={ppmT("canvas.add_document")}
            onClick={() => onRunCommand("add-document")}
          />
          <RailButton
            disabled={!editReady}
            expanded={expanded}
            icon={ListChecks}
            label={ppmT("canvas.add_checklist")}
            onClick={() => onRunCommand("add-checklist")}
          />
          <RailButton
            disabled={!editReady}
            expanded={expanded}
            icon={Table2}
            label={ppmT("canvas.add_table")}
            onClick={() => onRunCommand("add-table")}
          />
          <RailButton
            disabled={!editReady}
            expanded={expanded}
            icon={Code2}
            label={ppmT("canvas.add_code")}
            onClick={() => onRunCommand("add-code")}
          />
          <RailButton
            disabled={!editReady}
            expanded={expanded}
            icon={Group}
            label={ppmT("canvas.add_group")}
            shortcut="⇧G"
            onClick={() => onRunCommand("add-group")}
          />
          <RailButton
            disabled={!editReady}
            expanded={expanded}
            icon={Frame}
            label={ppmT("canvas.add_frame")}
            onClick={() => onRunCommand("add-frame")}
          />
          <RailButton
            disabled={!editReady}
            expanded={expanded}
            icon={Link}
            label={ppmT("canvas.add_board_link")}
            onClick={() => onRunCommand("add-board-link")}
          />
          <RailButton
            disabled={!editReady}
            expanded={expanded}
            icon={ListPlus}
            label={ppmT("canvas.add_work_item")}
            shortcut="⇧T"
            onClick={() => onRunCommand("add-work-item")}
          />
          <RailButton
            disabled={!editReady}
            expanded={expanded}
            icon={Columns3}
            label={ppmT("canvas.add_work_items_view")}
            onClick={() => onRunCommand("add-work-items-view")}
          />
          <RailButton
            disabled={!editReady}
            expanded={expanded}
            icon={Workflow}
            label={ppmT("canvas.add_diagram")}
            onClick={() => onRunCommand("add-diagram")}
          />
          <RailButton
            disabled={!editReady}
            expanded={expanded}
            icon={Presentation}
            label={ppmT("canvas.add_deck")}
            onClick={() => onRunCommand("add-deck")}
          />
          <RailButton
            disabled={!editReady}
            expanded={expanded}
            icon={GitFork}
            label={ppmT("canvas.draw_connection")}
            pressed={activeTool === "arrow"}
            onClick={() => onRunCommand("draw-connection")}
          />
          <RailButton
            // v2: the read-only list stays reachable when the board is read-only, in conflict or being restored.
            disabled={!editReady && !isCanvasCommandAllowedReadOnly("semantic-edges", designV2)}
            expanded={expanded}
            icon={Network}
            label={ppmT("canvas.semantic_edges")}
            onClick={() => onRunCommand("semantic-edges")}
          />
          <RailButton
            disabled={!editReady}
            expanded={expanded}
            icon={Undo2}
            label={ppmT("canvas.undo")}
            onClick={() => onRunCommand("undo")}
          />
          <RailButton
            disabled={!editReady}
            expanded={expanded}
            icon={Redo2}
            label={ppmT("canvas.redo")}
            onClick={() => onRunCommand("redo")}
          />
        </>
      )}
      {designV2 && !canEdit && (
        <RailButton
          expanded={expanded}
          icon={Network}
          label={ppmT("canvas.semantic_edges")}
          onClick={() => onRunCommand("semantic-edges")}
        />
      )}
      {(!designV2 || (expanded && canEdit)) && <RailSectionLabel expanded={expanded} label={ppmT("canvas.view")} />}
      {!designV2 && (
        <>
          <RailButton
            expanded={expanded}
            icon={Focus}
            label={ppmT("canvas.fit_view")}
            onClick={() => onRunCommand("fit-view")}
          />
          <RailButton
            expanded={expanded}
            icon={ZoomIn}
            label={ppmT("canvas.zoom_in")}
            onClick={() => onRunCommand("zoom-in")}
          />
          <RailButton
            expanded={expanded}
            icon={ZoomOut}
            label={ppmT("canvas.zoom_out")}
            onClick={() => onRunCommand("zoom-out")}
          />
        </>
      )}
      {expanded && canEdit && (
        <div className="ppm-canvas-rail__align" aria-label={ppmT("canvas.align")}>
          <button
            disabled={!editReady}
            type="button"
            title={ppmT("canvas.align_left")}
            onClick={() => onRunCommand("align-left")}
          >
            <AlignStartVertical aria-hidden="true" />
          </button>
          <button
            type="button"
            title={ppmT("canvas.align_center_horizontal")}
            onClick={() => onRunCommand("align-center-horizontal")}
            disabled={!editReady}
          >
            <AlignCenterVertical aria-hidden="true" />
          </button>
          <button
            disabled={!editReady}
            type="button"
            title={ppmT("canvas.align_right")}
            onClick={() => onRunCommand("align-right")}
          >
            <AlignEndVertical aria-hidden="true" />
          </button>
          <button
            disabled={!editReady}
            type="button"
            title={ppmT("canvas.align_top")}
            onClick={() => onRunCommand("align-top")}
          >
            <AlignStartHorizontal aria-hidden="true" />
          </button>
          <button
            type="button"
            title={ppmT("canvas.align_center_vertical")}
            onClick={() => onRunCommand("align-center-vertical")}
            disabled={!editReady}
          >
            <AlignCenterHorizontal aria-hidden="true" />
          </button>
          <button
            disabled={!editReady}
            type="button"
            title={ppmT("canvas.align_bottom")}
            onClick={() => onRunCommand("align-bottom")}
          >
            <AlignEndHorizontal aria-hidden="true" />
          </button>
        </div>
      )}
    </aside>
  );
}

function RailButton({
  disabled = false,
  expanded,
  icon: Icon,
  label,
  onClick,
  // Only actual toggle buttons ("Холст" / "Нарисовать визуальную связь") pass this. Leaving it
  // undefined for plain action buttons (add-note, undo, ...) keeps aria-pressed off them entirely
  // instead of falsely announcing every rail button as a toggle.
  pressed,
  shortcut,
}: {
  disabled?: boolean;
  expanded: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  pressed?: boolean;
  shortcut?: string;
}) {
  return (
    <button
      type="button"
      className="ppm-canvas-rail-button"
      aria-pressed={pressed}
      data-active={pressed || undefined}
      disabled={disabled}
      title={label}
      onClick={onClick}
    >
      <Icon aria-hidden="true" />
      {expanded && (
        <>
          <span>{label}</span>
          {shortcut && <kbd>{shortcut}</kbd>}
        </>
      )}
    </button>
  );
}

function RailSectionLabel({ expanded, label }: { expanded: boolean; label: string }) {
  if (!expanded) return <span className="ppm-canvas-rail__divider" aria-hidden="true" />;
  return <small className="ppm-canvas-rail__label">{label}</small>;
}
