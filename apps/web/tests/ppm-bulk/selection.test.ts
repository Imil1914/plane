// Линия B: где включено выделение (B1) и помощники выделения — Shift-диапазон по паре «задача + группа» (одна задача
// бывает в нескольких группах: исполнители, метки, направления), без повторов, уже выделенных и свёрнутых групп;
// стрелки мимо свёрнутых групп; «призраки» после перезагрузки списка; клавиши не трогают выделение из полей ввода и
// диалогов (B5). Проверка на настоящем MultipleSelectStore — без React. Среда node.
import { EIssueLayoutTypes, EIssuesStoreType } from "@plane/types";
import { describe, expect, it } from "vitest";
import { isPpmBulkSelectionEnabled } from "@/hooks/use-bulk-operation-status";
import type { TEntityDetails } from "@/hooks/use-multiple-select";
import {
  getPpmEntitiesToAdd,
  getPpmMissingSelection,
  getPpmNeighbourEntities,
  getPpmShiftRange,
  isPpmSelectionKeyTargetIgnored,
} from "@/hooks/use-multiple-select-helpers";
import { MultipleSelectStore } from "@/store/multiple_select.store";

describe("где включено выделение", () => {
  const LISTS = [
    EIssuesStoreType.PROJECT,
    EIssuesStoreType.CYCLE,
    EIssuesStoreType.MODULE,
    EIssuesStoreType.PROJECT_VIEW,
    EIssuesStoreType.PROFILE,
    EIssuesStoreType.GLOBAL,
  ];

  it("«Список» и «Таблица»: задачи проекта, спринт, направление, виды, «Мои задачи», виды пространства", () => {
    for (const storeType of LISTS) {
      expect(isPpmBulkSelectionEnabled(EIssueLayoutTypes.LIST, storeType), `list ${storeType}`).toBe(true);
      expect(isPpmBulkSelectionEnabled(EIssueLayoutTypes.SPREADSHEET, storeType), `table ${storeType}`).toBe(true);
    }
  });

  it("«Доска», календарь и «Таймлайн» — без выделения; вызов без вида (корни «Таймлайна») — как было", () => {
    for (const layout of [EIssueLayoutTypes.KANBAN, EIssueLayoutTypes.CALENDAR, EIssueLayoutTypes.GANTT])
      expect(isPpmBulkSelectionEnabled(layout, EIssuesStoreType.PROJECT), layout).toBe(false);
    expect(isPpmBulkSelectionEnabled()).toBe(false);
    expect(isPpmBulkSelectionEnabled(undefined, EIssuesStoreType.PROJECT)).toBe(false);
  });

  it("эпики, архив и черновики — выключено", () => {
    for (const storeType of [EIssuesStoreType.EPIC, EIssuesStoreType.ARCHIVED, EIssuesStoreType.WORKSPACE_DRAFT])
      expect(isPpmBulkSelectionEnabled(EIssueLayoutTypes.LIST, storeType), storeType).toBe(false);
  });
});

const ids = (range: { entityID: string }[]) => range.map((entity) => entity.entityID);

/** Узел-заглушка без DOM: тег, атрибуты и родитель — `closest` понимает простые селекторы помощника. */
type TFakeNode = { tag: string; attrs?: Record<string, string>; parent?: TFakeNode };

function matchesSimple(node: TFakeNode, selector: string): boolean {
  const tag = /^[a-z]+/.exec(selector)?.[0];
  if (tag && node.tag !== tag) return false;
  const attrs = node.attrs ?? {};
  for (const [, name, value] of selector.replaceAll(/:not\(\[[^\]]*\]\)/g, "").matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g))
    if (!(name in attrs) || (value !== undefined && attrs[name] !== value)) return false;
  for (const [, name, value] of selector.matchAll(/:not\(\[([\w-]+)="([^"]*)"\]\)/g))
    if (attrs[name] === value) return false;
  return true;
}

const element = (node: TFakeNode) => ({
  isContentEditable: node.attrs?.contenteditable === "true",
  closest: (selector: string) => {
    const parts = selector.split(/,\s*/);
    for (let current: TFakeNode | undefined = node; current; current = current.parent)
      if (parts.some((part) => matchesSimple(current as TFakeNode, part))) return current;
    return null;
  },
});

const rowLink: TFakeNode = { tag: "a", attrs: { href: "/robot/1" } };
const dialog: TFakeNode = { tag: "div", attrs: { role: "dialog" } };

const row = (entityID: string, groupID: string): TEntityDetails => ({ entityID, groupID });
const pairs = (entities: TEntityDetails[]) => entities.map((entity) => `${entity.entityID}/${entity.groupID}`);
/** Группа «Готово» свёрнута — её строк не видно. */
const isDoneHidden = (entity: TEntityDetails) => entity.groupID === "done";

describe("Shift-клик — диапазон", () => {
  const list = [row("a", "g1"), row("b", "g1"), row("c", "g2"), row("d", "g2"), row("e", "g2")];

  it("вниз и вверх от опорной строки, опорная не входит, нажатая входит; через границу групп", () => {
    expect(ids(getPpmShiftRange(list, row("a", "g1"), row("d", "g2")))).toEqual(["b", "c", "d"]);
    expect(ids(getPpmShiftRange(list, row("e", "g2"), row("b", "g1")))).toEqual(["b", "c", "d"]);
  });

  it("опорной строки нет в списке или нажата она сама — только нажатая; нажатой нет — пусто", () => {
    expect(ids(getPpmShiftRange(list, row("gone", "g1"), row("c", "g2")))).toEqual(["c"]);
    expect(ids(getPpmShiftRange(list, row("c", "g2"), row("c", "g2")))).toEqual(["c"]);
    expect(getPpmShiftRange(list, row("a", "g1"), row("gone", "g1"))).toEqual([]);
  });

  // Группировка по исполнителю: задача x с двумя исполнителями стоит и в группе Анны, и в группе Бориса.
  const byAssignee = [row("a", "anna"), row("x", "anna"), row("b", "anna"), row("x", "boris"), row("c", "boris")];

  it("задача в двух группах: опорная и нажатая ищутся по паре «задача + группа», а не по первому вхождению", () => {
    // Опорная — x во второй группе: диапазон начинается после неё, а не после x в первой группе.
    expect(pairs(getPpmShiftRange(byAssignee, row("x", "boris"), row("c", "boris")))).toEqual(["c/boris"]);
    expect(pairs(getPpmShiftRange(byAssignee, row("a", "anna"), row("x", "boris")))).toEqual([
      "x/anna",
      "b/anna",
      "x/boris",
    ]);
  });

  it("в выделение попадает каждая задача один раз и без уже выделенных", () => {
    const range = getPpmShiftRange(byAssignee, row("a", "anna"), row("c", "boris"));
    expect(pairs(getPpmEntitiesToAdd(range, () => false))).toEqual(["x/anna", "b/anna", "c/boris"]);
    expect(pairs(getPpmEntitiesToAdd(range, (id) => id === "b"))).toEqual(["x/anna", "c/boris"]);
  });

  it("свёрнутая группа в середине диапазона пропускается (её строк не видно)", () => {
    const withCollapsed = [
      row("a", "todo"),
      row("h1", "done"),
      row("h2", "done"),
      row("c", "later"),
      row("d", "later"),
    ];
    expect(ids(getPpmShiftRange(withCollapsed, row("a", "todo"), row("d", "later"), isDoneHidden))).toEqual(["c", "d"]);
    expect(ids(getPpmShiftRange(withCollapsed, row("d", "later"), row("a", "todo"), isDoneHidden))).toEqual(["a", "c"]);
  });
});

describe("стрелки", () => {
  const list = [row("a", "todo"), row("h1", "done"), row("x", "later"), row("x", "boris"), row("c", "boris")];

  it("соседи — видимые строки, свёрнутая группа пропускается", () => {
    const { previousEntity, nextEntity } = getPpmNeighbourEntities(list, row("a", "todo"), isDoneHidden);
    expect(previousEntity).toBeNull();
    expect(nextEntity).toEqual(row("x", "later"));
    expect(getPpmNeighbourEntities(list, row("x", "later"), isDoneHidden).previousEntity).toEqual(row("a", "todo"));
  });

  it("позиция — по паре: из второго вхождения задачи идём дальше, а не возвращаемся к первому", () => {
    expect(getPpmNeighbourEntities(list, row("x", "boris"), isDoneHidden)).toEqual({
      previousEntity: row("x", "later"),
      nextEntity: row("c", "boris"),
    });
    expect(getPpmNeighbourEntities(list, row("gone", "todo"), isDoneHidden)).toEqual({
      previousEntity: null,
      nextEntity: null,
    });
  });
});

describe("на настоящем MultipleSelectStore", () => {
  // Как это делает use-multiple-select: Shift-клик → диапазон → без повторов и уже выделенных → массовое добавление.
  const shiftAdd = (
    store: MultipleSelectStore,
    entities: TEntityDetails[],
    target: TEntityDetails,
    isHidden?: (entity: TEntityDetails) => boolean
  ) => {
    const anchor = store.getLastSelectedEntityDetails();
    if (!anchor) throw new Error("no anchor");
    const range = getPpmShiftRange(entities, anchor, target, isHidden);
    store.bulkUpdateSelectedEntityDetails(getPpmEntitiesToAdd(range, store.getIsEntitySelected), "add");
    store.updateLastSelectedEntityDetails(target);
  };

  it("задача в двух группах не удваивает «Выбрано: N»", () => {
    const store = new MultipleSelectStore();
    const byAssignee = [row("a", "anna"), row("x", "anna"), row("b", "anna"), row("x", "boris"), row("c", "boris")];
    store.updateSelectedEntityDetails(row("a", "anna"), "add");
    shiftAdd(store, byAssignee, row("c", "boris"));
    expect(store.selectedEntityIds).toEqual(["a", "x", "b", "c"]);
    // Флажок группы Бориса поверх уже выделенных: без второй записи x.
    store.bulkUpdateSelectedEntityDetails(
      getPpmEntitiesToAdd([row("x", "boris"), row("c", "boris")], store.getIsEntitySelected),
      "add"
    );
    expect(store.selectedEntityIds).toEqual(["a", "x", "b", "c"]);
  });

  it("свёрнутая группа в середине диапазона не выделяется", () => {
    const store = new MultipleSelectStore();
    const withCollapsed = [row("a", "todo"), row("h1", "done"), row("h2", "done"), row("c", "later")];
    store.updateSelectedEntityDetails(row("a", "todo"), "add");
    shiftAdd(store, withCollapsed, row("c", "later"), (entity) => entity.groupID === "done");
    expect(store.selectedEntityIds).toEqual(["a", "c"]);
  });
});

describe("перезагрузка списка не оставляет «призраков»", () => {
  it("находит выделенные задачи, которых больше нет в списке", () => {
    const entities = [
      { entityID: "a", groupID: "g" },
      { entityID: "c", groupID: "g" },
    ];
    expect(getPpmMissingSelection(["a", "b", "c", "d"], entities)).toEqual(["b", "d"]);
    expect(getPpmMissingSelection([], entities)).toEqual([]);
  });
});

describe("клавиши выделения не срабатывают из полей и диалогов", () => {
  it("поле ввода, редактор, диалог, открытое меню — пропускаем", () => {
    expect(isPpmSelectionKeyTargetIgnored(element({ tag: "input", attrs: { type: "text" } }))).toBe(true);
    expect(isPpmSelectionKeyTargetIgnored(element({ tag: "input" }))).toBe(true);
    expect(isPpmSelectionKeyTargetIgnored(element({ tag: "textarea" }))).toBe(true);
    expect(isPpmSelectionKeyTargetIgnored(element({ tag: "div", attrs: { contenteditable: "true" } }))).toBe(true);
    expect(isPpmSelectionKeyTargetIgnored(element({ tag: "button", parent: dialog }))).toBe(true);
    const listbox: TFakeNode = { tag: "ul", attrs: { role: "listbox" } };
    expect(isPpmSelectionKeyTargetIgnored(element({ tag: "li", parent: listbox }))).toBe(true);
  });

  it("флажок строки, кнопка панели, страница — обрабатываем (Esc с флажка в фокусе снимает выделение)", () => {
    expect(
      isPpmSelectionKeyTargetIgnored(element({ tag: "input", attrs: { type: "checkbox" }, parent: rowLink }))
    ).toBe(false);
    expect(isPpmSelectionKeyTargetIgnored(element({ tag: "button", attrs: { type: "button" } }))).toBe(false);
    expect(isPpmSelectionKeyTargetIgnored(element({ tag: "div", attrs: { contenteditable: "false" } }))).toBe(false);
    expect(isPpmSelectionKeyTargetIgnored(element({ tag: "body" }))).toBe(false);
    expect(isPpmSelectionKeyTargetIgnored(null)).toBe(false);
    expect(isPpmSelectionKeyTargetIgnored({})).toBe(false);
  });
});
