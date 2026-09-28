// Линия B (массовые действия, просьба владельца 2026-09-28): чистая логика панели — формы числа, доступность кнопок
// при одном и нескольких проектах, удаление по одной задаче как в обычном диалоге (права: автор или администратор
// проекта, частичные отказы, не больше 5 запросов сразу), «замена» исполнителя, «Без спринта», ограничение
// параллельности и блокировка повторного запуска. Среда node, без DOM и сторов.
import { getPpmTranslation } from "@ppm/brand";
import type { TPpmTranslationKey } from "@ppm/brand";
import { describe, expect, it, vi } from "vitest";
import {
  canPpmDeleteIssue,
  createPpmBulkRunGuard,
  describePpmBulkDelete,
  describePpmBulkUpdate,
  formatPpmBulkCount,
  getPpmBulkAvailability,
  getPpmBulkSprintOptions,
  intersectPpmMemberIds,
  isPpmPermissionError,
  planPpmAssigneeChange,
  planPpmBulkDelete,
  planPpmCycleChange,
  planPpmStateChange,
  runPpmBulkDelete,
  runPpmCycleChange,
  runPpmFieldChanges,
  runPpmWithConcurrency,
  PPM_BULK_CONCURRENCY,
} from "@/components/issues/bulk-operations/bulk-actions";
import type { TPpmBulkIssue } from "@/components/issues/bulk-operations/bulk-actions";

const ru = (key: TPpmTranslationKey) => getPpmTranslation("ru", key);
const en = (key: TPpmTranslationKey) => getPpmTranslation("en", key);

const ROBOT = "p-robot";
const BIO = "p-bio";
const ME = "u-me";
const ANNA = "u-anna";

function task(id: string, projectId: string | null, overrides: Partial<TPpmBulkIssue> = {}): TPpmBulkIssue {
  return {
    id,
    projectId,
    label: `${projectId === BIO ? "BIO" : "ROBOT"}-${id}`,
    stateId: "s-todo",
    assigneeIds: [],
    cycleId: null,
    createdBy: ANNA,
    parentId: null,
    subIssuesCount: 0,
    ...overrides,
  };
}

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("формы числа", () => {
  it("«Выбрано: N» — 1 задача, 2 задачи, 5 задач (и 11, 21, 22, 0)", () => {
    const selected = (count: number) => formatPpmBulkCount(ru, "bulk.selected", count, "ru");
    expect(selected(1)).toBe("Выбрано: 1 задача");
    expect(selected(2)).toBe("Выбрано: 2 задачи");
    expect(selected(5)).toBe("Выбрано: 5 задач");
    expect(selected(11)).toBe("Выбрано: 11 задач");
    expect(selected(21)).toBe("Выбрано: 21 задача");
    expect(selected(22)).toBe("Выбрано: 22 задачи");
    expect(selected(0)).toBe("Выбрано: 0 задач");
  });

  it("вопрос об удалении и итоги — в нужном падеже", () => {
    expect(formatPpmBulkCount(ru, "bulk.delete_title", 1, "ru")).toBe("Удалить 1 задачу?");
    expect(formatPpmBulkCount(ru, "bulk.delete_title", 3, "ru")).toBe("Удалить 3 задачи?");
    expect(formatPpmBulkCount(ru, "bulk.delete_title", 5, "ru")).toBe("Удалить 5 задач?");
    expect(formatPpmBulkCount(ru, "bulk.delete_title", 21, "ru")).toBe("Удалить 21 задачу?");
    expect(formatPpmBulkCount(ru, "bulk.deleted", 1, "ru")).toBe("Удалена 1 задача");
    expect(formatPpmBulkCount(ru, "bulk.deleted", 3, "ru")).toBe("Удалено 3 задачи");
    expect(formatPpmBulkCount(ru, "bulk.deleted", 5, "ru")).toBe("Удалено 5 задач");
    expect(formatPpmBulkCount(ru, "bulk.updated", 1, "ru")).toBe("Обновлена 1 задача");
    expect(formatPpmBulkCount(ru, "bulk.updated", 4, "ru")).toBe("Обновлено 4 задачи");
    expect(formatPpmBulkCount(ru, "bulk.updated", 12, "ru")).toBe("Обновлено 12 задач");
    expect(formatPpmBulkCount(ru, "bulk.not_deleted_rights", 1, "ru")).toBe("1 не удалена — нет прав");
    expect(formatPpmBulkCount(ru, "bulk.not_deleted_rights", 2, "ru")).toBe("2 не удалены — нет прав");
  });

  it("английский интерфейс — по-английски", () => {
    expect(formatPpmBulkCount(en, "bulk.selected", 1, "en")).toBe("1 task selected");
    expect(formatPpmBulkCount(en, "bulk.selected", 2, "en")).toBe("2 tasks selected");
    expect(formatPpmBulkCount(en, "bulk.delete_title", 1, "en")).toBe("Delete 1 task?");
    expect(formatPpmBulkCount(en, "bulk.delete_title", 7, "en")).toBe("Delete 7 tasks?");
  });
});

/** Права как у обычного удаления: `admin` — проекты, где я администратор; автор задачи — `createdBy`. */
const rights = (admin: string[]) => ({
  currentUserId: ME,
  isProjectAdmin: (projectId: string) => admin.includes(projectId),
});

const rules = (admin: string[] = [ROBOT, BIO], sprintsOn: string[] = [ROBOT, BIO]) => ({
  canDelete: (issue: TPpmBulkIssue) => canPpmDeleteIssue(issue, rights(admin)),
  isSprintEnabled: (projectId: string) => sprintsOn.includes(projectId),
});

describe("доступность кнопок", () => {
  it("задачи одного проекта: доступны статус, исполнитель, спринт и удаление", () => {
    const availability = getPpmBulkAvailability([task("1", ROBOT), task("2", ROBOT)], rules());
    expect(availability).toMatchObject({
      total: 2,
      projectIds: [ROBOT],
      singleProjectId: ROBOT,
      statusHintKey: null,
      assigneeHintKey: null,
      sprintHintKey: null,
      deleteHintKey: null,
      deletableCount: 2,
    });
  });

  it("задачи нескольких проектов: статус и спринт неактивны с подсказкой, исполнитель и удаление — нет", () => {
    const availability = getPpmBulkAvailability([task("1", ROBOT), task("2", BIO), task("3", ROBOT)], rules());
    expect(availability.projectIds).toEqual([ROBOT, BIO]);
    expect(availability.singleProjectId).toBeNull();
    expect(availability.statusHintKey).toBe("bulk.one_project_hint");
    expect(availability.sprintHintKey).toBe("bulk.one_project_hint");
    expect(ru("bulk.one_project_hint")).toBe("Выделите задачи одного проекта");
    expect(availability.assigneeHintKey).toBeNull();
    expect(availability.deleteHintKey).toBeNull();
    expect(availability.deletableCount).toBe(3);
  });

  it("спринты выключены в проекте — спринт неактивен со своей подсказкой", () => {
    const availability = getPpmBulkAvailability([task("1", ROBOT)], rules([ROBOT], []));
    expect(availability.statusHintKey).toBeNull();
    expect(availability.sprintHintKey).toBe("bulk.sprints_off_hint");
  });

  it("чужие задачи без прав администратора — удаление неактивно; свои и задачи «своих» проектов — заранее видно K из N", () => {
    expect(getPpmBulkAvailability([task("1", ROBOT), task("2", BIO)], rules([]))).toMatchObject({
      deletableCount: 0,
      deleteHintKey: "bulk.delete_no_rights_hint",
    });
    expect(getPpmBulkAvailability([task("1", ROBOT), task("2", BIO), task("3", BIO)], rules([BIO]))).toMatchObject({
      deletableCount: 2,
      deleteHintKey: null,
    });
    // Своя задача удаляется и без прав администратора — как в обычном диалоге удаления.
    const mine = task("4", ROBOT, { createdBy: ME });
    expect(getPpmBulkAvailability([task("1", ROBOT), mine], rules([]))).toMatchObject({
      deletableCount: 1,
      deleteHintKey: null,
    });
  });

  it("пустое выделение — всё неактивно", () => {
    const availability = getPpmBulkAvailability([], rules());
    expect(availability.total).toBe(0);
    expect(availability.statusHintKey).not.toBeNull();
    expect(availability.assigneeHintKey).not.toBeNull();
    expect(availability.sprintHintKey).not.toBeNull();
    expect(availability.deleteHintKey).not.toBeNull();
  });
});

describe("удаление: как обычное удаление задачи, по одной", () => {
  it("права — как у обычного удаления: автор задачи или администратор проекта", () => {
    const own = task("1", ROBOT, { createdBy: ME });
    const foreign = task("2", ROBOT, { createdBy: ANNA });
    expect(canPpmDeleteIssue(own, rights([]))).toBe(true);
    expect(canPpmDeleteIssue(foreign, rights([ROBOT]))).toBe(true);
    expect(canPpmDeleteIssue(own, rights([ROBOT]))).toBe(true);
    expect(canPpmDeleteIssue(foreign, rights([]))).toBe(false);
    expect(canPpmDeleteIssue(foreign, rights([BIO]))).toBe(false);
    // Без проекта — нельзя; пользователь ещё не загружен — только как администратор.
    expect(canPpmDeleteIssue(task("3", null, { createdBy: ME }), rights([ROBOT]))).toBe(false);
    expect(canPpmDeleteIssue(own, { currentUserId: undefined, isProjectAdmin: () => false })).toBe(false);
    expect(
      canPpmDeleteIssue(task("4", ROBOT, { createdBy: null }), {
        currentUserId: undefined,
        isProjectAdmin: () => false,
      })
    ).toBe(false);
    expect(canPpmDeleteIssue(own, { currentUserId: undefined, isProjectAdmin: () => true })).toBe(true);
  });

  it("задачи без прав не отправляются; остальные — по одной, в порядке выделения, без группировки по проектам", () => {
    const plan = planPpmBulkDelete(
      [task("1", ROBOT), task("2", BIO, { createdBy: ME }), task("3", ROBOT), task("4", "p-other"), task("5", null)],
      (issue) => canPpmDeleteIssue(issue, rights([ROBOT]))
    );
    expect(plan.items).toEqual([
      { issueId: "1", projectId: ROBOT },
      { issueId: "2", projectId: BIO },
      { issueId: "3", projectId: ROBOT },
    ]);
    expect(plan.deniedIds).toEqual(["4", "5"]);
    expect(plan).toMatchObject({ total: 5, deleteCount: 3, cascadeIds: [], extraSubItemsCount: 0 });
  });

  it("частичные отказы: ошибка сервера и отказ сервера в правах по одной задаче не мешают остальным", async () => {
    const plan = planPpmBulkDelete(
      [task("1", ROBOT), task("2", BIO), task("3", ROBOT), task("4", BIO), task("5", "p-x")],
      (issue) => canPpmDeleteIssue(issue, rights([ROBOT, BIO]))
    );
    const removeIssue = vi.fn(async (_projectId: string, issueId: string) => {
      // Так сервис задач бросает тело ответа: 500 и 403 (права поменялись, пока список был открыт).
      if (issueId === "2") throw { error: "Something went wrong please try again later" };
      if (issueId === "3") throw { error: "You don't have the required permissions." };
    });
    const outcome = await runPpmBulkDelete(plan, removeIssue);
    expect(removeIssue).toHaveBeenCalledTimes(4);
    expect(removeIssue).toHaveBeenCalledWith(ROBOT, "1");
    expect(removeIssue).toHaveBeenCalledWith(BIO, "2");
    expect(removeIssue).toHaveBeenCalledWith(ROBOT, "3");
    expect(removeIssue).toHaveBeenCalledWith(BIO, "4");
    expect(outcome).toEqual({
      succeededIds: ["1", "4"],
      unchangedIds: [],
      failedIds: ["2"],
      deniedIds: ["5", "3"],
      cascadedIds: [],
    });
  });

  it("отказ в правах узнаётся по ответу сервера, остальное — ошибка", () => {
    expect(isPpmPermissionError({ error: "You don't have the required permissions." })).toBe(true);
    expect(isPpmPermissionError({ detail: "You do not have permission to perform this action." })).toBe(true);
    expect(isPpmPermissionError({ error: "Only admin or creator can delete the work item" })).toBe(true);
    expect(isPpmPermissionError({ status: 403 })).toBe(true);
    expect(isPpmPermissionError({ error: "Something went wrong please try again later" })).toBe(false);
    expect(isPpmPermissionError(new Error("Network Error"))).toBe(false);
    expect(isPpmPermissionError(undefined)).toBe(false);
  });

  it(`не больше ${PPM_BULK_CONCURRENCY} удалений одновременно`, async () => {
    const issues = Array.from({ length: 12 }, (_, index) => task(String(index + 1), ROBOT));
    const plan = planPpmBulkDelete(issues, () => true);
    let inFlight = 0;
    let peak = 0;
    const outcome = await runPpmBulkDelete(plan, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
    });
    expect(peak).toBe(PPM_BULK_CONCURRENCY);
    expect(outcome.succeededIds).toEqual(issues.map((issue) => issue.id));
  });

  it("повторы одной задачи (она в нескольких группах) отправляются один раз", async () => {
    const x = task("x", ROBOT);
    const plan = planPpmBulkDelete([x, task("1", ROBOT), x], () => true);
    expect(plan.items.map((item) => item.issueId)).toEqual(["x", "1"]);
    expect(plan).toMatchObject({ total: 2, deleteCount: 2 });
    const removeIssue = vi.fn(async () => undefined);
    await runPpmBulkDelete(plan, removeIssue);
    expect(removeIssue).toHaveBeenCalledTimes(2);
  });

  describe("подзадачи удаляются вместе с родителем (как при обычном удалении)", () => {
    const parent = task("P", ROBOT, { subIssuesCount: 3 });
    const child = task("C", ROBOT, { parentId: "P", subIssuesCount: 1 });
    const other = task("T", ROBOT);

    it("(a) задачу, чей родитель тоже удаляется, не отправляем — её удалит сервер вместе с родителем", async () => {
      const plan = planPpmBulkDelete([child, parent, other], () => true);
      expect(plan.items.map((item) => item.issueId)).toEqual(["P", "T"]);
      expect(plan.cascadeIds).toEqual(["C"]);
      const removeIssue = vi.fn(async () => undefined);
      const outcome = await runPpmBulkDelete(plan, removeIssue);
      expect(removeIssue).toHaveBeenCalledTimes(2);
      expect(removeIssue).not.toHaveBeenCalledWith(ROBOT, "C");
      expect(outcome).toEqual({
        succeededIds: ["P", "C", "T"],
        unchangedIds: [],
        failedIds: [],
        deniedIds: [],
        cascadedIds: ["C"],
      });
    });

    it("(a) предок через невыделенную задачу: цепочка родителей берётся из данных списка", () => {
      const grandchild = task("G", ROBOT, { parentId: "C" });
      const parents: Record<string, string | null> = { G: "C", C: "P", P: null };
      const plan = planPpmBulkDelete(
        [grandchild, parent],
        () => true,
        (id) => parents[id]
      );
      expect(plan.items.map((item) => item.issueId)).toEqual(["P"]);
      expect(plan.cascadeIds).toEqual(["G"]);
    });

    it("(a) не удалось удалить родителя — подзадачу удаляем отдельно следующим шагом", async () => {
      const plan = planPpmBulkDelete([parent, child], () => true);
      const removeIssue = vi.fn(async (_projectId: string, issueId: string) => {
        if (issueId === "P") throw { error: "Something went wrong please try again later" };
      });
      const outcome = await runPpmBulkDelete(plan, removeIssue);
      expect(removeIssue.mock.calls.map((call) => call[1])).toEqual(["P", "C"]);
      expect(outcome).toMatchObject({ succeededIds: ["C"], failedIds: ["P"], cascadedIds: [] });
    });

    it("(a) чужая подзадача без прав уходит вместе с родителем; не ушёл родитель — «нет прав»", async () => {
      const foreignChild = task("F", ROBOT, { parentId: "P", createdBy: ANNA });
      const mine = task("P", ROBOT, { createdBy: ME, subIssuesCount: 1 });
      const canDelete = (issue: TPpmBulkIssue) => canPpmDeleteIssue(issue, rights([]));
      const plan = planPpmBulkDelete([mine, foreignChild], canDelete);
      expect(plan).toMatchObject({ total: 2, deleteCount: 2, deniedIds: [], cascadeIds: ["F"] });
      const ok = await runPpmBulkDelete(plan, async () => undefined);
      expect(ok).toMatchObject({ succeededIds: ["P", "F"], cascadedIds: ["F"], deniedIds: [] });
      const failed = await runPpmBulkDelete(plan, async () => {
        throw { error: "Something went wrong please try again later" };
      });
      expect(failed).toMatchObject({ succeededIds: [], failedIds: ["P"], deniedIds: ["F"] });
    });

    it("(b) числа подтверждения: удалится K из N выделенных и M подзадач вне выделения", () => {
      // P: 3 подзадачи (одна из них — выделенная C), C: 1 своя. Вне выделения удалятся 3 + 1 − 1 = 3.
      const foreign = task("X", BIO);
      const plan = planPpmBulkDelete([parent, child, other, foreign], (issue) => issue.projectId === ROBOT);
      expect(plan).toMatchObject({ total: 4, deleteCount: 3, extraSubItemsCount: 3, deniedIds: ["X"] });
      // Отправляется только то, что нужно: P и T; C уходит вместе с P.
      expect(plan.items.map((item) => item.issueId)).toEqual(["P", "T"]);
    });
  });

  it("итог — «Удалено K задач; M не удалены — нет прав» и ошибки сервера отдельно", () => {
    expect(
      describePpmBulkDelete(
        { succeededIds: ["1", "2", "3"], unchangedIds: [], failedIds: [], deniedIds: ["4", "5"] },
        ru,
        "ru"
      )
    ).toEqual({
      type: "warning",
      title: ru("bulk.toast_partial"),
      message: "Удалено 3 задачи; 2 не удалены — нет прав",
    });
    expect(
      describePpmBulkDelete(
        { succeededIds: ["1", "2", "3", "4", "5"], unchangedIds: [], failedIds: [], deniedIds: [] },
        ru,
        "ru"
      )
    ).toEqual({ type: "success", title: ru("bulk.toast_done"), message: "Удалено 5 задач" });
    expect(
      describePpmBulkDelete({ succeededIds: [], unchangedIds: [], failedIds: ["1"], deniedIds: ["2", "3"] }, ru, "ru")
    ).toEqual({
      type: "error",
      title: ru("bulk.toast_failed"),
      message: "2 не удалены — нет прав; 1 не удалена — ошибка сервера",
    });
  });
});

describe("статус и исполнитель", () => {
  it("статус: задачи с тем же статусом не отправляются", () => {
    const plan = planPpmStateChange([task("1", ROBOT), task("2", ROBOT, { stateId: "s-done" })], "s-done");
    expect(plan.changes).toEqual([{ issueId: "1", projectId: ROBOT, data: { state_id: "s-done" } }]);
    expect(plan.unchangedIds).toEqual(["2"]);
  });

  it("повторы одной задачи из разных групп изменяются один раз", () => {
    const x = task("x", ROBOT);
    expect(planPpmStateChange([x, x], "s-done").changes).toHaveLength(1);
    expect(planPpmAssigneeChange([x, x], "u-vera").changes).toHaveLength(1);
    expect(planPpmCycleChange([x, x], "c-1").moveIds).toEqual(["x"]);
    expect(getPpmBulkAvailability([x, x, task("y", ROBOT)], rules()).total).toBe(2);
  });

  it("исполнитель ЗАМЕНЯЕТ исполнителей выделенных задач", () => {
    const plan = planPpmAssigneeChange(
      [
        task("1", ROBOT, { assigneeIds: ["u-anna", "u-boris"] }),
        task("2", ROBOT, { assigneeIds: ["u-vera"] }),
        task("3", ROBOT, { assigneeIds: [] }),
        task("4", BIO, { assigneeIds: ["u-vera"] }),
      ],
      "u-vera"
    );
    expect(plan.changes).toEqual([
      { issueId: "1", projectId: ROBOT, data: { assignee_ids: ["u-vera"] } },
      { issueId: "3", projectId: ROBOT, data: { assignee_ids: ["u-vera"] } },
    ]);
    expect(plan.unchangedIds).toEqual(["2", "4"]);
  });

  it("«Без исполнителя» снимает всех исполнителей", () => {
    const plan = planPpmAssigneeChange(
      [task("1", ROBOT, { assigneeIds: ["u-anna", "u-boris"] }), task("2", ROBOT, { assigneeIds: [] })],
      null
    );
    expect(plan.changes).toEqual([{ issueId: "1", projectId: ROBOT, data: { assignee_ids: [] } }]);
    expect(plan.unchangedIds).toEqual(["2"]);
    expect(ru("bulk.assignee_none")).toBe("Без исполнителя");
    expect(ru("bulk.assignee_replace_hint")).toMatch(/замен/i);
  });

  it("обновление по одной: частичный отказ оставляет неудачи отдельным списком", async () => {
    const plan = planPpmStateChange([task("1", ROBOT), task("2", ROBOT), task("3", ROBOT, { stateId: "s-x" })], "s-x");
    const apply = vi.fn(async (change: { issueId: string }) => {
      if (change.issueId === "2") throw new Error("403");
    });
    const outcome = await runPpmFieldChanges(plan, apply);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({ succeededIds: ["1"], unchangedIds: ["3"], failedIds: ["2"], deniedIds: [] });
  });

  it("итог — «Обновлено K задач» или список неудач", () => {
    const labels = { "1": "ROBOT-1", "2": "ROBOT-2", "3": "ROBOT-3" };
    expect(
      describePpmBulkUpdate(
        { succeededIds: ["1", "2"], unchangedIds: ["3"], failedIds: [], deniedIds: [] },
        labels,
        ru,
        "ru"
      )
    ).toEqual({ type: "success", title: ru("bulk.toast_done"), message: "Обновлено 3 задачи" });
    expect(
      describePpmBulkUpdate(
        { succeededIds: ["1"], unchangedIds: [], failedIds: ["2", "3"], deniedIds: [] },
        labels,
        ru,
        "ru"
      )
    ).toEqual({
      type: "warning",
      title: ru("bulk.toast_partial"),
      message: "Обновлена 1 задача; не удалось: ROBOT-2, ROBOT-3",
    });
    expect(
      describePpmBulkUpdate(
        { succeededIds: [], unchangedIds: [], failedIds: ["1", "2"], deniedIds: [] },
        labels,
        ru,
        "ru"
      )
    ).toEqual({ type: "error", title: ru("bulk.toast_failed"), message: "Не удалось обновить: ROBOT-1, ROBOT-2" });
  });

  it("длинный список неудач сокращается: первые 5 и «и ещё N»", () => {
    const ids = ["1", "2", "3", "4", "5", "6", "7"];
    const labels = Object.fromEntries(ids.map((id) => [id, `BIO-${id}`]));
    const toast = describePpmBulkUpdate(
      { succeededIds: [], unchangedIds: [], failedIds: ids, deniedIds: [] },
      labels,
      ru,
      "ru"
    );
    expect(toast.message).toBe("Не удалось обновить: BIO-1, BIO-2, BIO-3, BIO-4, BIO-5 и ещё 2");
  });
});

describe("спринт", () => {
  it("«Без спринта» убирает из спринта только задачи, которые в нём есть", () => {
    const plan = planPpmCycleChange([task("1", ROBOT, { cycleId: "c-1" }), task("2", ROBOT)], null);
    expect(plan).toEqual({
      cycleId: null,
      projectId: ROBOT,
      moveIds: [],
      removeItems: [{ issueId: "1", projectId: ROBOT }],
      unchangedIds: ["2"],
    });
    expect(ru("bulk.sprint_none")).toBe("Без спринта");
  });

  it("перенос в спринт — одним массовым вызовом, без задач, которые уже там", async () => {
    const plan = planPpmCycleChange(
      [task("1", ROBOT, { cycleId: "c-1" }), task("2", ROBOT, { cycleId: "c-2" }), task("3", ROBOT)],
      "c-2"
    );
    expect(plan).toMatchObject({ cycleId: "c-2", projectId: ROBOT, moveIds: ["1", "3"], unchangedIds: ["2"] });
    const actions = {
      addIssuesToCycle: vi.fn(async () => undefined),
      removeIssueFromCycle: vi.fn(async () => undefined),
    };
    const outcome = await runPpmCycleChange(plan, actions);
    expect(actions.addIssuesToCycle).toHaveBeenCalledTimes(1);
    expect(actions.addIssuesToCycle).toHaveBeenCalledWith(ROBOT, "c-2", ["1", "3"]);
    expect(actions.removeIssueFromCycle).not.toHaveBeenCalled();
    expect(outcome).toEqual({ succeededIds: ["1", "3"], unchangedIds: ["2"], failedIds: [], deniedIds: [] });
  });

  it("ошибка массового переноса — все переносимые задачи в неудачах", async () => {
    const plan = planPpmCycleChange([task("1", ROBOT), task("2", ROBOT)], "c-done");
    const outcome = await runPpmCycleChange(plan, {
      addIssuesToCycle: async () => {
        throw new Error("400: The Cycle has already been completed");
      },
      removeIssueFromCycle: async () => undefined,
    });
    expect(outcome).toEqual({ succeededIds: [], unchangedIds: [], failedIds: ["1", "2"], deniedIds: [] });
  });

  it("«Без спринта» — по одной, неудача одной задачи не мешает остальным", async () => {
    const plan = planPpmCycleChange(
      [
        task("1", ROBOT, { cycleId: "c-1" }),
        task("2", ROBOT, { cycleId: "c-1" }),
        task("3", ROBOT, { cycleId: "c-2" }),
      ],
      null
    );
    const removeIssueFromCycle = vi.fn(async (_projectId: string, issueId: string) => {
      if (issueId === "2") throw new Error("500");
    });
    const outcome = await runPpmCycleChange(plan, { addIssuesToCycle: async () => undefined, removeIssueFromCycle });
    expect(removeIssueFromCycle).toHaveBeenCalledTimes(3);
    expect(outcome).toEqual({ succeededIds: ["1", "3"], unchangedIds: [], failedIds: ["2"], deniedIds: [] });
  });

  it("в меню — текущий и будущие спринты (и без дат), без завершённых и архивных", () => {
    const today = new Date(2026, 8, 28);
    const options = getPpmBulkSprintOptions(
      [
        { id: "c-draft", name: "Идеи", status: "DRAFT", start_date: null, end_date: null },
        { id: "c-late", name: "Спринт 12", status: "UPCOMING", start_date: "2026-10-12", end_date: "2026-10-25" },
        { id: "c-done", name: "Спринт 9", status: "COMPLETED", start_date: "2026-09-01", end_date: "2026-09-14" },
        { id: "c-next", name: "Спринт 11", status: "UPCOMING", start_date: "2026-09-29", end_date: "2026-10-11" },
        { id: "c-now", name: "Спринт 10", status: "CURRENT", start_date: "2026-09-15", end_date: "2026-09-28" },
        {
          id: "c-arch",
          name: "Старый",
          status: "UPCOMING",
          start_date: "2026-11-01",
          end_date: "2026-11-10",
          archived_at: "2026-09-01",
        },
        { id: "c-nostatus", name: "Без статуса", start_date: "2026-08-01", end_date: "2026-08-10" },
      ],
      today
    );
    expect(options.map((option) => [option.id, option.phase])).toEqual([
      ["c-now", "current"],
      ["c-next", "upcoming"],
      ["c-late", "upcoming"],
      ["c-draft", "draft"],
    ]);
  });
});

describe("исполнители для задач нескольких проектов", () => {
  it("только общие участники всех проектов выделения, в порядке первого проекта", () => {
    expect(
      intersectPpmMemberIds([
        ["u-me", "u-anna", "u-boris"],
        ["u-boris", "u-me"],
      ])
    ).toEqual(["u-me", "u-boris"]);
    expect(intersectPpmMemberIds([["u-me"]])).toEqual(["u-me"]);
    expect(intersectPpmMemberIds([["u-me"], ["u-anna"]])).toEqual([]);
  });

  it("пока участники проекта не загружены — список не готов", () => {
    expect(intersectPpmMemberIds([["u-me"], null])).toBeNull();
    expect(intersectPpmMemberIds([])).toBeNull();
  });
});

describe("надёжность", () => {
  it(`по одной — не больше ${PPM_BULK_CONCURRENCY} запросов одновременно`, async () => {
    let inFlight = 0;
    let peak = 0;
    const gates = Array.from({ length: 12 }, () => deferred());
    const run = runPpmWithConcurrency(
      gates.map((_, index) => index),
      PPM_BULK_CONCURRENCY,
      async (index) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await gates[index].promise;
        inFlight -= 1;
        if (index === 7) throw new Error("fail");
      }
    );
    // Отпускаем задания по одному, давая бегуну взять следующее.
    const release = async (index: number): Promise<void> => {
      if (index >= gates.length) return;
      gates[index].resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return release(index + 1);
    };
    await release(0);
    const result = await run;
    expect(peak).toBe(PPM_BULK_CONCURRENCY);
    expect(result.fulfilled).toHaveLength(11);
    expect(result.rejected).toEqual([7]);
  });

  it("второе действие не запускается, пока идёт первое", async () => {
    const guard = createPpmBulkRunGuard();
    const listener = vi.fn();
    const unsubscribe = guard.subscribe(listener);
    const gate = deferred();
    const first = guard.run(async () => {
      await gate.promise;
      return "first";
    });
    expect(guard.isBusy()).toBe(true);
    const second = vi.fn(async () => "second");
    await expect(guard.run(second)).resolves.toEqual({ started: false });
    expect(second).not.toHaveBeenCalled();
    gate.resolve();
    await expect(first).resolves.toEqual({ started: true, value: "first" });
    expect(guard.isBusy()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    await expect(guard.run(second)).resolves.toEqual({ started: true, value: "second" });
    unsubscribe();
  });

  it("сбой действия освобождает блокировку", async () => {
    const guard = createPpmBulkRunGuard();
    await expect(
      guard.run(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(guard.isBusy()).toBe(false);
  });
});
