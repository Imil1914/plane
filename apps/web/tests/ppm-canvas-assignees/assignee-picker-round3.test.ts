// G2.1 · линия C, раунд 3 ревью: (1) передача фокуса после пересоздания карточки — только внутри своей «Доски задач»
// (ключ с id узла) и своей доски (корень доски); (2) видимость кнопки: прямоугольники обрезающих предков и
// elementFromPoint — только когда сдвинулся прямоугольник кнопки, а не каждый кадр. Env node, без DOM.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createAssigneeAnchorWatch,
  findAssigneeAnchor,
  workItemsViewAnchorKey,
} from "@/components/ppm-canvas/canvas-assignee-picker";

type TFakeButton = { dataset: { ppmAssigneeAnchor: string }; focus: ReturnType<typeof vi.fn> };

function focusables() {
  const focused: TFakeButton[] = [];
  const button = (key: string, focusable = true): TFakeButton => {
    const element: TFakeButton = { dataset: { ppmAssigneeAnchor: key }, focus: vi.fn() };
    element.focus.mockImplementation(() => {
      if (focusable) focused.push(element);
    });
    return element;
  };
  const doc = {
    get activeElement() {
      return (focused.at(-1) ?? null) as Element | null;
    },
  };
  const root = (...buttons: TFakeButton[]) => ({
    querySelectorAll: vi.fn(() => buttons as unknown as NodeListOf<HTMLElement>),
  });
  return { button, doc, root };
}

describe("раунд 3 · 1: передача фокуса — только своя «Доска задач» и своя доска", () => {
  it("ключ кнопки — id узла «Доски задач» и id задачи: две доски задач с одной задачей не делят ключ", () => {
    expect(workItemsViewAnchorKey("shape:view-a", "task-1")).toBe("work-items-view:shape:view-a:task-1");
    expect(workItemsViewAnchorKey("shape:view-a", "task-1")).not.toBe(workItemsViewAnchorKey("shape:view-b", "task-1"));
  });

  it("ищет только в корне своей доски: кнопка с тем же ключом на другой доске фокус не получает", () => {
    const { button, doc, root } = focusables();
    const key = workItemsViewAnchorKey("shape:view-a", "task-1");
    const otherBoard = button(key);
    const hidden = button(key, false); // скрыта (visibility: hidden) — focus() не срабатывает, ищем дальше
    const moved = button(key);
    const boardA = root(hidden, button(workItemsViewAnchorKey("shape:view-b", "task-1")), moved);
    const boardB = root(otherBoard);
    expect(findAssigneeAnchor(boardA, key, doc)).toBe(moved);
    expect(otherBoard.focus).not.toHaveBeenCalled();
    expect(boardB.querySelectorAll).not.toHaveBeenCalled();
    expect(boardA.querySelectorAll).toHaveBeenCalledWith("button[data-ppm-assignee-anchor]");
    expect(findAssigneeAnchor(root(), key, doc)).toBeNull();
  });

  it("подключение: ключ собирается из id узла, узел передаёт свой id и канбану, и списку; поиск — в корне доски", () => {
    const flat = (name: string) =>
      readFileSync(new URL(`../../core/components/ppm-canvas/${name}`, import.meta.url), "utf8").replace(/\s+/g, " ");
    const shape = flat("shape.tsx");
    expect(shape).toContain("anchorKey={workItemsViewAnchorKey(viewId, item.identity.entity_id)}");
    expect(shape).not.toContain("anchorKey={`work-items-view:");
    expect(shape.match(/viewId=\{shape\.id\}/g)).toHaveLength(2);
    const picker = flat("canvas-assignee-picker.tsx");
    expect(picker).toContain('triggerRef.current?.closest(".ppm-canvas-shell")');
    expect(picker).toContain("findAssigneeAnchor(board, key, document)");
    expect(picker).not.toContain("findAssigneeAnchor(document,");
  });
});

describe("раунд 3 · 2: видимость кнопки — пересчёт только при сдвиге", () => {
  const viewport = { height: 600, width: 800 };
  const zones = { layer: null, surface: null, trigger: null, workspace: null };

  function watch(clip = { bottom: 600, left: 0, right: 800, top: 0 }) {
    const clipRects = vi.fn(() => [clip]);
    const hitsAt = vi.fn((points: Array<[number, number]>) => points.map(() => null));
    return { check: createAssigneeAnchorWatch({ clipRects, hitsAt, zones }), clipRects, hitsAt };
  }

  it("тот же прямоугольник, окно и видимость — ни предков, ни elementFromPoint", () => {
    const { check, clipRects, hitsAt } = watch();
    const rect = { bottom: 128, left: 50, right: 200, top: 100 };
    const first = check(rect, true, viewport);
    expect(first).toEqual({ covered: false, visible: rect });
    for (let frame = 0; frame < 5; frame += 1) expect(check({ ...rect }, true, viewport)).toBe(first);
    // Сдвиг меньше половины пикселя — тот же ключ (как у размещения списка).
    expect(check({ bottom: 128.2, left: 50.3, right: 200.1, top: 100.4 }, true, viewport)).toBe(first);
    expect(clipRects).toHaveBeenCalledTimes(1);
    expect(hitsAt).toHaveBeenCalledTimes(1);
  });

  it("сдвинулась кнопка, изменилось окно или видимость — пересчёт", () => {
    const { check, clipRects, hitsAt } = watch({ bottom: 150, left: 0, right: 800, top: 0 });
    const rect = { bottom: 128, left: 50, right: 200, top: 100 };
    check(rect, true, viewport);
    // Колонку прокрутили — кнопка ушла ниже её видимой части.
    expect(check({ bottom: 228, left: 50, right: 200, top: 200 }, true, viewport)).toEqual({
      covered: false,
      visible: null,
    });
    expect(check(rect, true, { height: 500, width: 800 }).visible).toEqual(rect);
    // Скрытая вкладка: прямоугольник тот же, а кнопки не видно — без замеров предков.
    expect(check(rect, false, { height: 500, width: 800 })).toEqual({ covered: false, visible: null });
    expect(clipRects).toHaveBeenCalledTimes(3);
    expect(hitsAt).toHaveBeenCalledTimes(2);
  });

  it("кнопку закрыла панель — covered; результат держится, пока кнопка не сдвинется", () => {
    const workspace = { contains: () => true };
    const clipRects = vi.fn(() => []);
    const hitsAt = vi.fn((points: Array<[number, number]>) => points.map(() => ({}) as Node));
    const check = createAssigneeAnchorWatch({
      clipRects,
      hitsAt,
      zones: { layer: null, surface: null, trigger: null, workspace },
    });
    const rect = { bottom: 128, left: 50, right: 200, top: 100 };
    expect(check(rect, true, viewport).covered).toBe(true);
    expect(check(rect, true, viewport).covered).toBe(true);
    expect(hitsAt).toHaveBeenCalledTimes(1);
  });
});
