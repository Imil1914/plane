// Линия B, раунд 3: поведение панели без React — что именно она делает по нажатию. Удаление: повторы и права,
// числа подтверждения («Удалить K задач?», «Можно удалить K из N», «Вместе с ними удалятся подзадачи: M»), вызовы
// removeIssue, строки подзадач, ушедших с родителем, снятие выделения, итог. Изменения: снятие выделения с успешных и
// возврат в выделение неудачных, которые оптимистичное обновление успело убрать из списка («Без спринта» на странице
// этого спринта). Среда node.
import { getPpmTranslation } from "@ppm/brand";
import type { TPpmTranslationKey } from "@ppm/brand";
import { describe, expect, it, vi } from "vitest";
import { createPpmBulkRunGuard } from "@/components/issues/bulk-operations/bulk-actions";
import type { TPpmBulkIssue } from "@/components/issues/bulk-operations/bulk-actions";
import { runPpmBulkDeleteFlow, runPpmBulkUpdateFlow } from "@/components/issues/bulk-operations/bulk-flow";
import type { TPpmBulkDeleteDialog } from "@/components/issues/bulk-operations/bulk-flow";
import type { TEntityDetails } from "@/hooks/use-multiple-select";

const ru = (key: TPpmTranslationKey) => getPpmTranslation("ru", key);
const ROBOT = "p-robot";
const BIO = "p-bio";
const ME = "u-me";

function task(id: string, overrides: Partial<TPpmBulkIssue> = {}): TPpmBulkIssue {
  return {
    id,
    projectId: ROBOT,
    label: `ROBOT-${id}`,
    stateId: "s-todo",
    assigneeIds: [],
    cycleId: null,
    createdBy: ME,
    parentId: null,
    subIssuesCount: 0,
    ...overrides,
  };
}

const row = (entityID: string, groupID = "g"): TEntityDetails => ({ entityID, groupID });

function io(overrides: Record<string, unknown> = {}) {
  return {
    translate: ru,
    locale: "ru",
    guard: createPpmBulkRunGuard(),
    notify: vi.fn(),
    deselect: vi.fn(),
    reselect: vi.fn(),
    ...overrides,
  };
}

function deleteIo(overrides: Record<string, unknown> = {}) {
  return {
    ...io(),
    rights: { currentUserId: ME, isProjectAdmin: (projectId: string) => projectId === ROBOT },
    confirm: vi.fn(async (_dialog: TPpmBulkDeleteDialog) => true),
    removeIssue: vi.fn(async (_projectId: string, _issueId: string) => undefined),
    removeFromList: vi.fn(),
    ...overrides,
  };
}

describe("удаление", () => {
  // P (3 подзадачи, одна из них — выделенная C) и T в ROBOT, где я администратор; X — чужая задача в BIO.
  const parent = task("P", { subIssuesCount: 3 });
  const child = task("C", { parentId: "P" });
  const other = task("T");
  const foreign = task("X", { projectId: BIO, label: "BIO-X", createdBy: "u-anna" });

  it("подтверждение: без повторов, K из N, подзадачи вне выделения; фокус на «Отмена»", async () => {
    const deps = deleteIo();
    // x в двух группах (исполнители) — одна задача.
    await runPpmBulkDeleteFlow([parent, child, other, other, foreign], deps);
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(deps.confirm.mock.calls[0][0]).toEqual({
      title: "Удалить 3 задачи?",
      lines: [
        "Можно удалить 3 из 4: чужие задачи удаляет только администратор проекта.",
        "Вместе с ними удалятся подзадачи: 2",
        "Это действие нельзя отменить.",
      ],
      confirmLabel: "Удалить",
      cancelLabel: "Отмена",
      initialFocus: "secondary",
    });
  });

  it("отправляет только нужное, убирает строки ушедших с родителем подзадач, снимает выделение, пишет итог", async () => {
    const deps = deleteIo();
    const result = await runPpmBulkDeleteFlow([parent, child, other, foreign], deps);
    expect(deps.removeIssue.mock.calls).toEqual([
      [ROBOT, "P"],
      [ROBOT, "T"],
    ]);
    expect(deps.removeFromList).toHaveBeenCalledWith(["C"]);
    expect(deps.deselect).toHaveBeenCalledWith(["P", "C", "T"]);
    expect(deps.notify).toHaveBeenCalledWith({
      type: "warning",
      title: ru("bulk.toast_partial"),
      message: "Удалено 3 задачи; 1 не удалена — нет прав",
    });
    expect(result).toMatchObject({ status: "done" });
  });

  it("отмена в диалоге — ничего не удаляется", async () => {
    const deps = deleteIo({ confirm: vi.fn(async () => false) });
    expect(await runPpmBulkDeleteFlow([other], deps)).toEqual({ status: "cancelled" });
    expect(deps.removeIssue).not.toHaveBeenCalled();
    expect(deps.deselect).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it("удалить нечего (только чужие задачи) — диалог не открывается", async () => {
    const deps = deleteIo();
    expect(await runPpmBulkDeleteFlow([foreign], deps)).toEqual({ status: "empty" });
    expect(deps.confirm).not.toHaveBeenCalled();
  });

  it("идёт другое действие — не спрашивает и не запускает второе", async () => {
    const guard = createPpmBulkRunGuard();
    let release!: () => void;
    const running = guard.run(() => new Promise<void>((resolve) => (release = resolve)));
    const deps = deleteIo({ guard });
    expect(await runPpmBulkDeleteFlow([other], deps)).toEqual({ status: "busy" });
    expect(deps.confirm).not.toHaveBeenCalled();
    release();
    await running;
  });

  it("родитель не удалился — подзадача удаляется отдельно, неудача остаётся выделенной", async () => {
    const deps = deleteIo({
      removeIssue: vi.fn(async (_projectId: string, issueId: string) => {
        if (issueId === "P") throw { error: "Something went wrong please try again later" };
      }),
    });
    await runPpmBulkDeleteFlow([parent, child], deps);
    expect(deps.removeIssue.mock.calls.map((call) => call[1])).toEqual(["P", "C"]);
    expect(deps.removeFromList).not.toHaveBeenCalled();
    expect(deps.deselect).toHaveBeenCalledWith(["C"]);
    expect(deps.notify).toHaveBeenCalledWith({
      type: "warning",
      title: ru("bulk.toast_partial"),
      message: "Удалена 1 задача; 1 не удалена — ошибка сервера",
    });
  });
});

describe("изменения", () => {
  it("«Без спринта» на странице этого спринта: неудачные возвращаются в выделение, успешные снимаются", async () => {
    const a = task("A", { cycleId: "c-now" });
    const b = task("B", { cycleId: "c-now" });
    const deps = {
      ...io(),
      updateIssue: vi.fn(async () => undefined),
      addIssuesToCycle: vi.fn(async () => undefined),
      removeIssueFromCycle: vi.fn(async (_projectId: string, issueId: string) => {
        if (issueId === "B") throw new Error("500");
      }),
    };
    const selection = [row("A", "todo"), row("B", "todo")];
    const result = await runPpmBulkUpdateFlow([a, b], selection, { kind: "cycle", cycleId: null }, deps);
    expect(result).toMatchObject({ status: "done" });
    expect(deps.deselect).toHaveBeenCalledWith(["A"]);
    expect(deps.reselect).toHaveBeenCalledWith([row("B", "todo")]);
    expect(deps.notify).toHaveBeenCalledWith({
      type: "warning",
      title: ru("bulk.toast_partial"),
      message: "Обновлена 1 задача; не удалось: ROBOT-B",
    });
  });

  it("статус: по одной, без повторов и без задач, где он уже такой; перенос в спринт — одним запросом", async () => {
    const a = task("A");
    const b = task("B", { stateId: "s-done" });
    const deps = {
      ...io(),
      updateIssue: vi.fn(async () => undefined),
      addIssuesToCycle: vi.fn(async () => undefined),
      removeIssueFromCycle: vi.fn(async () => undefined),
      refreshCycleStats: vi.fn(),
    };
    await runPpmBulkUpdateFlow([a, a, b], [row("A"), row("B")], { kind: "state", stateId: "s-done" }, deps);
    expect(deps.updateIssue.mock.calls).toEqual([[ROBOT, "A", { state_id: "s-done" }]]);
    expect(deps.deselect).toHaveBeenCalledWith(["A", "B"]);
    expect(deps.reselect).not.toHaveBeenCalled();

    await runPpmBulkUpdateFlow([a, b], [row("A"), row("B")], { kind: "cycle", cycleId: "c-next" }, deps);
    expect(deps.addIssuesToCycle).toHaveBeenCalledWith(ROBOT, "c-next", ["A", "B"]);
    expect(deps.refreshCycleStats).toHaveBeenCalledWith(ROBOT);
  });

  it("исполнитель: замена на выбранного у каждой задачи", async () => {
    const deps = {
      ...io(),
      updateIssue: vi.fn(async () => undefined),
      addIssuesToCycle: vi.fn(async () => undefined),
      removeIssueFromCycle: vi.fn(async () => undefined),
    };
    await runPpmBulkUpdateFlow(
      [task("A", { assigneeIds: ["u-anna", "u-boris"] })],
      [row("A")],
      { kind: "assignee", memberId: "u-vera" },
      deps
    );
    expect(deps.updateIssue).toHaveBeenCalledWith(ROBOT, "A", { assignee_ids: ["u-vera"] });
  });
});
