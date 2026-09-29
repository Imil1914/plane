// Линия B (B1, B5): выделение подключено в «Списке» и «Таблице» (включая «Мои задачи» и виды пространства — там в
// адресе нет projectId), флажок строки виден при наведении и пока выделение активно, «Таймлайн» не тронут.
// Статическая проверка исходников — разметку этих файлов в env node без сторов не отрендерить.
import { readFileSync } from "node:fs";
import { getPpmTranslation } from "@ppm/brand";
import { describe, expect, it } from "vitest";
import { getPpmSelectableEntities } from "@/hooks/use-multiple-select-helpers";

const CORE = new URL("../../core/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, CORE), "utf8");

const LIST = "components/issues/issue-layouts/list/";
const TABLE = "components/issues/issue-layouts/spreadsheet/";

describe("включение по виду и стору", () => {
  it("«Список» и «Таблица» спрашивают статус со своим видом и стором", () => {
    expect(read(`${LIST}default.tsx`)).toContain("useBulkOperationStatus(EIssueLayoutTypes.LIST, storeType)");
    expect(read(`${TABLE}spreadsheet-view.tsx`)).toContain(
      "useBulkOperationStatus(EIssueLayoutTypes.SPREADSHEET, storeType)"
    );
  });

  it("корни «Таймлайна» по-прежнему зовут хук без вида — там выделения нет", () => {
    expect(read("components/issues/issue-layouts/gantt/base-gantt-root.tsx")).toContain("useBulkOperationStatus()");
    expect(read("components/gantt-chart/chart/main-content.tsx")).toContain("useBulkOperationStatus()");
  });
});

describe("выделяются только строки с флажком", () => {
  it("«выбрать всё» и Shift-диапазон не берут задачи, которые нельзя менять", () => {
    const editable = new Set(["a", "c"]);
    expect(getPpmSelectableEntities({ g1: ["a", "b"], g2: ["c"], g3: [] }, (id) => editable.has(id))).toEqual({
      g1: ["a"],
      g2: ["c"],
      g3: [],
    });
  });

  it("список и таблица фильтруют группы тем же правилом, что и флажок строки (canEditProperties)", () => {
    expect(read(`${LIST}default.tsx`)).toContain("getPpmSelectableEntities(");
    expect(read(`${TABLE}spreadsheet-view.tsx`)).toContain("getPpmSelectableEntities(");
  });
});

describe("флажки в «Моих задачах» и видах пространства", () => {
  it("флажок строки не требует projectId в адресе, есть только у задач верхнего уровня и виден при активном выделении", () => {
    for (const file of [`${LIST}block.tsx`, `${TABLE}issue-row.tsx`]) {
      const source = read(file);
      expect(source, file).not.toMatch(/\{projectId && canSelectIssues/);
      expect(source, file).toMatch(/disabled=\{!!projectId && issue(?:Detail)?\.project_id !== projectId\}/);
      expect(source, file).toContain("selectionHelpers.isSelectionActive");
      // С клавиатуры: флажок в фокусе виден и без наведения мыши.
      expect(source, file).toContain("focus-visible:opacity-100");
    }
    expect(read(`${LIST}block.tsx`)).toMatch(/\{canSelectIssues && !isEpic && !isSubIssue && \(/);
    expect(read(`${TABLE}issue-row.tsx`)).toMatch(/\{canSelectIssues && nestingLevel === 0 && \(/);
  });

  it("флажок группы и шапки таблицы — и без projectId в адресе", () => {
    for (const file of [`${LIST}headers/group-by-card.tsx`, `${TABLE}spreadsheet-header.tsx`]) {
      const source = read(file);
      expect(source, file).toContain(
        "!selectionHelpers.isSelectionDisabled && (projectId ? canEditProperties(projectId.toString()) : true)"
      );
      expect(source, file).toContain("selectionHelpers.isSelectionActive");
      expect(source, file).toContain("focus-visible:opacity-100");
    }
  });
});

describe("use-multiple-select", () => {
  const source = read("hooks/use-multiple-select.ts");

  it("вопрос при уходе со страницы — по-русски из словаря", () => {
    expect(source).toContain('ppmT("bulk.leave_confirm")');
    expect(source).not.toContain("Are you sure you want to leave?");
    expect(getPpmTranslation("ru", "bulk.leave_confirm")).toBe("Уйти со страницы? Выделение задач сбросится.");
  });

  it("Shift-диапазон, «призраки», клавиши из полей ввода, флаг активного выделения, сброс при уходе со списка", () => {
    expect(source).toContain("getPpmShiftRange(");
    expect(source).toContain("getPpmMissingSelection(");
    expect(source).toContain("isPpmSelectionKeyTargetIgnored(");
    expect(source).toMatch(/isSelectionActive,\n/);
    expect(source).toContain("return () => clearSelection();");
    expect(source).not.toContain("console.log");
  });
});

describe("раунд 2: удаление как обычное удаление задачи", () => {
  const root = read("components/issues/bulk-operations/root.tsx");

  it("панель удаляет методом, которым удаляет обычный диалог (useIssuesActions → removeIssue), не bulk-delete-issues", () => {
    expect(root).toContain("useIssuesActions(storeType)");
    expect(root).toContain("removeIssue: (projectId, issueId) => removeIssue(projectId, issueId),");
    expect(root).toContain("runPpmBulkDeleteFlow(selectedIssues, deleteIO, selection)");
    expect(root).not.toContain("removeBulkIssues");
    // Сами списки передают диалогу удаления то же действие.
    expect(read("components/issues/issue-layouts/list/base-list-root.tsx")).toContain(
      "handleDelete={async () => removeIssue(issue.project_id, issue.id)}"
    );
  });

  it("права на удаление — те же, что у обычного диалога: автор задачи или администратор проекта", () => {
    const modal = read("components/issues/delete-issue-modal.tsx");
    expect(modal).toMatch(/created_by === currentUser\?\.id/);
    expect(modal).toMatch(/allowPermissions\(\s*\[EUserPermissions\.ADMIN\],\s*EUserPermissionsLevel\.PROJECT/);
    expect(root).toContain("const rights = { currentUserId: currentUser?.id, isProjectAdmin };");
    expect(root).toMatch(
      /allowPermissions\(\[EUserPermissions\.ADMIN\], EUserPermissionsLevel\.PROJECT, workspaceSlug, projectId\)/
    );
  });
});

describe("раунд 2: тосты шапки группы по-русски", () => {
  const card = read("components/issues/issue-layouts/list/headers/group-by-card.tsx");

  it("английские тосты — только запасной вариант Plane при выключенной оболочке PPM", () => {
    for (const literal of [
      '"Success!"',
      '"Work items added to the cycle successfully."',
      '"Error!"',
      '"Selected work items could not be added to the cycle. Please try again."',
    ]) {
      const lines = card.split("\n").filter((line) => line.includes(literal));
      expect(lines, literal).toHaveLength(1);
      expect(lines[0], literal).toMatch(/isPpmShell\s*\?[^:]*:\s*"/);
    }
  });

  it("спринт и направление называются своими словами", () => {
    expect(getPpmTranslation("ru", "bulk.group.added_to_sprint")).toBe("Задачи добавлены в спринт.");
    expect(getPpmTranslation("ru", "bulk.group.added_to_direction")).toBe("Задачи добавлены в направление.");
    expect(getPpmTranslation("ru", "bulk.group.add_failed_sprint")).toMatch(/^Не удалось добавить задачи в спринт/);
    expect(getPpmTranslation("ru", "bulk.group.add_failed_direction")).toMatch(
      /^Не удалось добавить задачи в направление/
    );
  });
});

describe("D-4: флажок «прилипшей» шапки группы не перекрыт линией перетаскивания строки", () => {
  it("верхний индикатор перетаскивания строки (тот, что рядом с шапкой) не перехватывает клик", () => {
    const source = read(`${LIST}block-root.tsx`);
    expect(source).toContain("pointer-events-none absolute top-0 z-[2]");
    expect(source).toContain('isVisible={instruction === "DRAG_OVER"}');
  });

  it("нижний индикатор (конец списка, DRAG_BELOW) не тронут — перекрытия с шапкой там нет", () => {
    const source = read(`${LIST}block-root.tsx`);
    expect(source).toContain('classNames={"absolute z-[2]"} isVisible={instruction === "DRAG_BELOW"}');
  });

  it("шапка группы остаётся «прилипшей» поверх строк (z-[2]) — индикатор строки её больше не перекрывает", () => {
    expect(read(`${LIST}list-group.tsx`)).toContain('"sticky top-0 z-[2]"');
  });
});

describe("раунд 3: проводка (поведение — в bulk-flow.test.ts и selection.test.ts)", () => {
  it("список пропускает строки свёрнутых групп: обёртки строки block-root нет — строка скрыта", () => {
    const list = read(`${LIST}default.tsx`);
    expect(list).toContain("<PpmMultipleSelectGroup");
    expect(list).toContain("isEntityHidden={isPpmListRowHidden}");
    expect(list).toContain("!document.getElementById(getIssueBlockId(entity.entityID, entity.groupID))");
    expect(read(`${LIST}block-root.tsx`)).toContain("id={getIssueBlockId(issueId, groupId)}");
  });

  it("хук выделения: диапазон и стрелки — по паре и мимо скрытых строк, добавление — без повторов", () => {
    const hook = read("hooks/use-multiple-select.ts");
    expect(hook).toContain("getPpmShiftRange(entitiesList, lastSelectedEntityDetails, target, isHidden)");
    expect(hook).toContain("getPpmNeighbourEntities(entitiesList, entityDetails, isHidden)");
    expect(hook).toContain("getPpmEntitiesToAdd(entityDetails, getIsEntitySelected)");
  });

  it("панель: выделение без повторов, подтверждение удаления с первым фокусом на «Отмена»", () => {
    const root = read("components/issues/bulk-operations/root.tsx");
    expect(root).toContain("const selectedIds = [...new Set(selectedEntityIds)];");
    expect(root).toContain("usePpmBulkDeleteConfirm()");
    expect(read("components/issues/bulk-operations/delete-confirm.tsx")).toContain(
      'initialFocus={dialog?.initialFocus ?? "secondary"}'
    );
  });
});

describe("D-2: обёртка Combobox панели действий отдаёт клавишу чистой функции, а не решает сама (review-W5 №7)", () => {
  // action-bar-view.test.tsx (D-2) закрепляет только shouldPpmBulkPickerConsumeKeyDown саму по себе: если
  // handleMenuKeyDown в bulk-picker.tsx перестанет её звать первым делом (вернётся к старому `if (inactive) return;`),
  // те тесты остаются зелёными — регрессия не поймана. Здесь — проверка исходника самого обработчика.
  const source = read("components/issues/bulk-operations/bulk-picker.tsx");
  const match = source.match(
    /const handleMenuKeyDown = \(event: KeyboardEvent<HTMLDivElement>\) => \{\n([\s\S]*?)\n {2}\};/
  );

  it("handleMenuKeyDown найден в bulk-picker.tsx", () => {
    expect(
      match,
      "не нашли const handleMenuKeyDown = (event) => {…}; в bulk-picker.tsx — обновите регэксп теста"
    ).not.toBeNull();
  });

  it("первая строка обработчика — guard через shouldPpmBulkPickerConsumeKeyDown, не свой `if (inactive) return;`", () => {
    const body = match?.[1] ?? "";
    const firstLine = body.split("\n")[0]?.trim();
    // Старый `if (inactive) return;` (до D-2) не смотрел на isOpen: Esc уже закрытого меню всё равно доходил до
    // handleKeyDown ниже, тот глотал событие (stopPropagation+preventDefault), и второй Esc не снимал выделение
    // панели (root.tsx:156). Проверяем именно первую строку — guard должен стоять до handleKeyDown, а не после.
    expect(firstLine).toBe("if (!shouldPpmBulkPickerConsumeKeyDown(event.key, isOpen, inactive)) return;");
  });

  it("guard стоит раньше вызова handleKeyDown — решение не подменяется по пути", () => {
    const body = match?.[1] ?? "";
    const guardAt = body.indexOf("shouldPpmBulkPickerConsumeKeyDown(");
    const consumeAt = body.indexOf("handleKeyDown(event)");
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(consumeAt).toBeGreaterThan(guardAt);
  });
});
