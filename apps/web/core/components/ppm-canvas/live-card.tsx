import {
  ArrowUpRight,
  Code2,
  Columns3,
  Frame,
  Group,
  Link,
  ListChecks,
  Presentation,
  StickyNote,
  Table2,
  Workflow,
  FileText,
  type LucideIcon,
} from "lucide-react";
import { stopEventPropagation } from "tldraw";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import type { TPpmCanvasOwnedNodeKind } from "@ppm/canvas";
import type { TPpmLiveSource } from "./canvas-grammar";

// «Три узла» — знак живой карточки: данные приходят из источника (TOKENS §9 п.1: акцент — знак живой карточки).
export function LiveGlyph() {
  const ppmT = usePpmTranslation();
  return (
    <span className="ppm-live-glyph" title={ppmT("canvas.live_card_hint")}>
      <svg viewBox="0 0 16 16" width="14" height="14" role="img" aria-label={ppmT("canvas.live_card")} fill="none">
        <path
          d="M3.75 3.75 12.25 8 5.25 12.25"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
        />
        <circle cx="3.75" cy="3.75" r="2" fill="currentColor" />
        <circle cx="12.25" cy="8" r="2" fill="currentColor" />
        <circle cx="5.25" cy="12.25" r="2" fill="currentColor" />
      </svg>
    </span>
  );
}

export function LiveSourceHeader({
  icon: Icon,
  identifier,
  source,
  sourceLabel,
}: {
  icon: LucideIcon;
  identifier?: string | null;
  source: TPpmLiveSource;
  sourceLabel: string;
}) {
  return (
    <div className="ppm-live-card__header" data-source={source}>
      <Icon aria-hidden="true" className="ppm-live-card__source-icon" />
      <span className="ppm-live-card__source">{sourceLabel}</span>
      {identifier && <span className="ppm-live-card__id">{identifier}</span>}
      <LiveGlyph />
    </div>
  );
}

export function LiveOpenLink({
  external,
  href,
  label,
}: {
  // True only for links that leave PPM (e.g. the Git card's provider URL). Internal PPM links (task, vault
  // file, page) stay same-tab, matching their v1 behaviour — see the callers in shape.tsx.
  external?: boolean;
  href: string;
  label: string;
}) {
  const ppmT = usePpmTranslation();
  return (
    <a
      className="ppm-live-card__open"
      href={href}
      aria-label={label}
      rel={external ? "noreferrer" : undefined}
      target={external ? "_blank" : undefined}
      title={label}
      onClick={stopEventPropagation}
      onKeyDown={stopEventPropagation}
      onPointerDown={stopEventPropagation}
    >
      {ppmT("canvas.open_short")}
      <ArrowUpRight aria-hidden="true" />
    </a>
  );
}

const OWN_NODE_ICONS = {
  note: StickyNote,
  document: FileText,
  checklist: ListChecks,
  table: Table2,
  code: Code2,
  group: Group,
  frame: Frame,
  board_link: Link,
  work_items_view: Columns3,
  diagram: Workflow,
  deck: Presentation,
} as const satisfies Record<TPpmCanvasOwnedNodeKind, LucideIcon>;

// Своя карточка нейтральна; цвет visual.color — только у этого глифа (TOKENS §8, «цвет — только подсказка»).
export function OwnNodeGlyph({ kind }: { kind: TPpmCanvasOwnedNodeKind }) {
  const Icon = OWN_NODE_ICONS[kind];
  return <Icon aria-hidden="true" className="ppm-canvas-node__type-icon" />;
}
