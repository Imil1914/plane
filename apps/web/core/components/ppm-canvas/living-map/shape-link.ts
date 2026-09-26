// AF2.2 F: глубокая ссылка на карточку доски. «На карте» в задаче (линия C) ведёт на
// …/brain?board=<board_id>&shape=<shape_id>; активная вкладка этой доски (editor.tsx, блок F) после загрузки
// выделяет карточку и подводит к ней камеру, не меняя масштаб. Тот же подвод — у клика по событию «Что изменилось».
import { getPpmProjectPath } from "@ppm/brand";
import type { Editor, TLShapeId } from "tldraw";

export const PPM_CANVAS_SHAPE_PARAM = "shape";

/** «На карте»: the Canvas address that opens `boardId` and reveals `shapeId` there. */
export function canvasShapeLinkPath(
  workspaceSlug: string,
  projectId: string,
  boardId: string,
  shapeId: string
): string {
  const query = new URLSearchParams({ board: boardId, [PPM_CANVAS_SHAPE_PARAM]: shapeId });
  return `${getPpmProjectPath(workspaceSlug, projectId, "brain")}?${query.toString()}`;
}

/**
 * The card of a «На карте» link addressed to this board: its tldraw id and the query without `shape` (the other
 * parameters stay; nothing left — ""). undefined without `shape` or when the link names another board.
 */
export function takeCanvasShapeLink(search: string, boardId: string): { search: string; shapeId: string } | undefined {
  const parameters = new URLSearchParams(search);
  const raw = parameters.get(PPM_CANVAS_SHAPE_PARAM)?.trim();
  if (!raw || parameters.get("board") !== boardId) return undefined;
  parameters.delete(PPM_CANVAS_SHAPE_PARAM);
  const rest = parameters.toString();
  return { search: rest ? `?${rest}` : "", shapeId: raw.startsWith("shape:") ? raw : `shape:${raw}` };
}

/**
 * Selects a card of this board and centres the camera on it, keeping the zoom; false — the board has no such card.
 * Доски одностраничные (один лист tldraw на доску), поэтому лист не переключаем (final-pass F2).
 */
export function revealCanvasShape(
  editor: Pick<Editor, "centerOnPoint" | "getShape" | "getShapePageBounds" | "select">,
  shapeId: string
): boolean {
  const id = shapeId as TLShapeId;
  const bounds = editor.getShape(id) ? editor.getShapePageBounds(id) : undefined;
  if (!bounds) return false;
  editor.select(id);
  editor.centerOnPoint(bounds.center, { animation: { duration: 220 } });
  return true;
}
