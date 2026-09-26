// AF2.2 C3: «На карте» в задаче — доски, где она лежит живой карточкой (S4), ссылка — глубокая ссылка F (открыть доску и
// выделить карточку); только облик v2; пусто или ошибка — строки нет; место — сразу после «Метки» в боковой панели и в
// превью; строки блока T (en/ru).
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { getPpmTranslation, PPM_TRANSLATIONS } from "@ppm/brand";
import { PpmCanvasChangesService } from "@/services/ppm-canvas-changes.service";
import { PpmCanvasServiceError } from "@/services/ppm-canvas.service";

const WS = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const TASK = "77777777-7777-4777-8777-777777777777";
const MAP = "44444444-4444-4444-8444-444444444444";
const RESEARCH = "44444444-4444-4444-8444-000000000002";
const read = (path: string) => readFileSync(new URL(`../../core/${path}`, import.meta.url), "utf8");
const component = read("components/issues/issue-detail/ppm-canvas-boards.tsx");
const sidebar = read("components/issues/issue-detail/sidebar.tsx");
const peek = read("components/issues/peek-overview/properties.tsx");

describe("«На карте» in the task (AF2.2 C3)", () => {
  it("asks S4 for the boards of the task, one row per board", async () => {
    const service = new PpmCanvasChangesService();
    const results = [
      { board_id: MAP, name: "Карта · Спринт 3", shape_id: "shape:1" },
      { board_id: RESEARCH, name: "Исследование", shape_id: "shape:2" },
    ];
    const get = vi.spyOn(service, "get").mockResolvedValue({ data: { results } } as never);
    await expect(service.getWorkItemBoards(WS, PROJECT, TASK)).resolves.toEqual({ results });
    expect(get).toHaveBeenCalledWith(
      `/api/ppm/v1/workspaces/${WS}/projects/${PROJECT}/canvas/work-items/${TASK}/boards/`
    );
  });

  it("turns «задача невидима» (404) into a service error the row swallows", async () => {
    const service = new PpmCanvasChangesService();
    vi.spyOn(service, "get").mockRejectedValue(
      Object.assign(new Error("Request failed"), {
        isAxiosError: true,
        response: {
          status: 404,
          data: {
            error: {
              code: "WORK_ITEM_NOT_FOUND",
              message: "Задача не найдена.",
              request_id: "99999999-9999-4999-8999-999999999999",
              details: {},
            },
          },
        },
      })
    );
    await expect(service.getWorkItemBoards(WS, PROJECT, TASK)).rejects.toBeInstanceOf(PpmCanvasServiceError);
    expect(component).toMatch(/catch \{[\s\S]*?if \(active\) setBoards\(\[\]\);/);
  });

  it("renders only under the v2 look, with the canvas on, and only when the task lies on a board", () => {
    expect(component).toContain("const designV2 = usePpmDesignV2();");
    expect(component).toContain("if (!designV2 || !CANVAS_ENABLED || !workspaceId) return;");
    expect(component).toContain("if (!designV2 || boards.length === 0) return null;");
    // Lane F's deep link (shape-link.ts): …/brain?board=<id>&shape=<shape_id> selects the card on that board.
    expect(component).toContain('import { canvasShapeLinkPath } from "@/components/ppm-canvas/living-map/shape-link";');
    expect(component).toContain("href={canvasShapeLinkPath(workspaceSlug, projectId, board.board_id, board.shape_id)}");
  });

  it("stays away in the minimal canvas mode: the link needs the AntyFlow board workspace (M-4)", () => {
    // Минимальный режим (PPM_ANTYFLOW_SHELL_ENABLED=0) — одна доска, ?board=/?shape= не читаются: ссылка открыла бы
    // другую доску без выделения. Флаг — тот же, что выбирает рабочее пространство в ppm-canvas/route.tsx.
    expect(component).toContain('import { isPpmAntyFlowShellEnabled, isPpmCanvasEnabled } from "@ppm/canvas";');
    expect(component.replace(/\s+/g, " ")).toContain(
      "const CANVAS_ENABLED = isPpmCanvasEnabled( process.env.PPM_CANVAS_ENABLED, isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED) ) && isPpmAntyFlowShellEnabled(process.env.PPM_ANTYFLOW_SHELL_ENABLED);"
    );
    expect(read("components/ppm-canvas/route.tsx")).toContain(
      "const isAntyFlowShellEnabled = isPpmAntyFlowShellEnabled(process.env.PPM_ANTYFLOW_SHELL_ENABLED);"
    );
    // Выключено — запроса S4 нет и строки нет.
    expect(component).toContain("if (!designV2 || !CANVAS_ENABLED || !workspaceId) return;");
  });

  it("sits right after «Метки» in the details sidebar and in the peek", () => {
    const mount =
      /label=\{t\("common\.labels"\)\}>[\s\S]*?<\/SidebarPropertyListItem>\s*\{\/\* ── AF2\.2 C: [^\n]*── \*\/\}\s*<PpmIssueCanvasBoards\s+workspaceSlug=\{workspaceSlug\}\s+projectId=\{projectId\}\s+issueId=\{issueId\}\s*\/>\s*\{\/\* ── \/AF2\.2 C ── \*\/\}/;
    expect(sidebar).toMatch(mount);
    expect(peek).toMatch(mount);
  });

  it("says «На карте» in both languages (block T)", () => {
    const keys = (locale: "en" | "ru") =>
      new Set(Object.keys(PPM_TRANSLATIONS[locale]).filter((key) => key.startsWith("issue.canvas_boards.")));
    expect(keys("ru")).toEqual(keys("en"));
    expect(keys("ru").size).toBe(2);
    expect(getPpmTranslation("ru", "issue.canvas_boards.label")).toBe("На карте");
    expect(getPpmTranslation("en", "issue.canvas_boards.label")).toBe("On the map");
  });
});
