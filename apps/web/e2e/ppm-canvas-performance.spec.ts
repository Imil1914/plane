import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

const baseURL = process.env.PPM_E2E_BASE_URL ?? "http://localhost:3000";
const apiBaseURL = process.env.PPM_E2E_API_BASE_URL ?? baseURL;
const currentUserURL = new URL("/api/users/me/", apiBaseURL).href;
const workspaceSlug = process.env.PPM_E2E_WORKSPACE_SLUG;
const workspaceId = process.env.PPM_E2E_WORKSPACE_ID;
const projectId = process.env.PPM_E2E_PROJECT_ID;
const FIXTURE_BOARDS = [
  "AF1.2 performance 300",
  "AF1.2 performance tab 2",
  "AF1.2 performance tab 3",
  "AF1.2 performance tab 4",
] as const;

if (process.env.PPM_E2E_BROWSER_CHANNEL) {
  test.use({ launchOptions: { channel: process.env.PPM_E2E_BROWSER_CHANNEL } });
}

type TestBoard = { board_id: string; name: string; status: string };
type BoardSnapshot = {
  version: number;
  snapshot: { document: { store: Record<string, { typeName?: string }> } } | null;
};

async function hasApiSession(page: Page): Promise<boolean> {
  const response = await page.request.get(currentUserURL);
  return response.status() === 200 && response.headers()["content-type"]?.includes("application/json") === true;
}

function boardsURL() {
  if (!workspaceId || !projectId) throw new Error("Missing isolated AF1.2 workspace/project IDs.");
  return new URL(`/api/ppm/v1/workspaces/${workspaceId}/projects/${projectId}/canvas/boards/`, apiBaseURL).href;
}

async function signIn(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const email = process.env.PPM_E2E_OWNER_EMAIL;
  const password = process.env.PPM_E2E_OWNER_PASSWORD;
  if (!email || !password) throw new Error("Missing local owner test credentials.");
  const context = await browser.newContext({ baseURL, locale: "ru-RU", viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto("/sign-in");
  await page.locator("#email").fill(email);
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /Продолжить|Открыть пространство/ }).click();
  await expect.poll(() => hasApiSession(page)).toBe(true);
  return { context, page };
}

async function readBoards(page: Page): Promise<{ default_board_id: string; boards: TestBoard[] }> {
  const response = await page.request.get(boardsURL());
  expect(response.status()).toBe(200);
  return response.json();
}

async function ensureFixtureBoards(page: Page): Promise<TestBoard[]> {
  const current = await readBoards(page);
  const boards = [...current.boards];
  for (const name of FIXTURE_BOARDS) {
    if (!boards.some((candidate) => candidate.name === name && candidate.status === "active")) {
      // Board creation is ordered because the project Canvas row may be initialized by the first request.
      // oxlint-disable-next-line eslint/no-await-in-loop
      const created = await page.request.post(boardsURL(), {
        data: { name, client_operation_id: crypto.randomUUID() },
      });
      expect(created.status()).toBe(201);
      // oxlint-disable-next-line eslint/no-await-in-loop
      const createdBoard: TestBoard = await created.json();
      boards.push(createdBoard);
    }
  }
  return FIXTURE_BOARDS.map((name) => {
    const board = boards.find((candidate) => candidate.name === name && candidate.status === "active");
    if (!board) throw new Error(`Missing synthetic fixture board: ${name}`);
    return board;
  });
}

async function readBoard(page: Page, boardId: string): Promise<BoardSnapshot> {
  const response = await page.request.get(`${boardsURL()}${boardId}/`);
  expect(response.status()).toBe(200);
  return response.json();
}

function countShapes(board: BoardSnapshot): number {
  return Object.values(board.snapshot?.document.store ?? {}).filter((record) => record.typeName === "shape").length;
}

function syntheticDesktopFlow(): string {
  const store = Object.fromEntries(
    Array.from({ length: 300 }, (_, index) => {
      const id = `shape:af12-performance-${index}`;
      return [
        id,
        {
          id,
          typeName: "shape",
          type: "flow-node",
          parentId: "page:page",
          x: (index % 20) * 360,
          y: Math.floor(index / 20) * 260,
          rotation: 0,
          props: {
            kind: "note",
            title: `AF1.2 performance ${index}`,
            body: `Synthetic note ${index}`,
            extra: "{}",
            w: 320,
            h: 220,
          },
        },
      ];
    })
  );
  return JSON.stringify({
    document: { schema: { schemaVersion: 2, sequences: {} }, store },
    session: { currentPageId: "page:page" },
  });
}

async function activateBoard(page: Page, board: TestBoard) {
  await page.locator(".ppm-canvas-board-switcher").click();
  await page.locator(".ppm-canvas-board-row__open").filter({ hasText: board.name }).click();
  await expect(page.locator('.ppm-canvas-workspace__editor[data-active="true"] [role="application"]')).toBeVisible();
  await expect(page.getByRole("tab", { name: board.name })).toHaveAttribute("aria-selected", "true");
}

function syntheticDesktopHierarchyFlow(): string {
  const records = [
    { id: "page:page", typeName: "page", name: "Page 1" },
    {
      id: "shape:hierarchy-group",
      typeName: "shape",
      type: "group",
      parentId: "page:page",
      x: 100,
      y: 100,
      rotation: 0,
      props: {},
    },
    {
      id: "shape:hierarchy-frame",
      typeName: "shape",
      type: "frame",
      parentId: "shape:hierarchy-group",
      x: 50,
      y: 60,
      rotation: 0,
      props: { name: "AF1.2 вложенная рамка", w: 500, h: 400 },
    },
    {
      id: "shape:hierarchy-note",
      typeName: "shape",
      type: "flow-node",
      parentId: "shape:hierarchy-frame",
      x: 20,
      y: 30,
      rotation: 0,
      props: { kind: "note", title: "AF1.2 вложенная заметка", body: "Без личных данных", extra: "{}", w: 320, h: 120 },
    },
    {
      id: "shape:hierarchy-sibling",
      typeName: "shape",
      type: "flow-node",
      parentId: "shape:hierarchy-group",
      x: 180,
      y: 70,
      rotation: 0,
      props: { kind: "note", title: "AF1.2 соседняя заметка", body: "Без личных данных", extra: "{}", w: 320, h: 120 },
    },
    {
      id: "shape:hierarchy-arrow",
      typeName: "shape",
      type: "arrow",
      parentId: "shape:hierarchy-frame",
      x: 15,
      y: 170,
      rotation: 0,
      props: { start: { x: 0, y: 0 }, end: { x: 160, y: 0 } },
    },
  ];
  return JSON.stringify({
    document: {
      schema: { schemaVersion: 2, sequences: {} },
      store: Object.fromEntries(records.map((record) => [record.id, record])),
    },
    session: { currentPageId: "page:page" },
  });
}

type ImportedShape = {
  id: string;
  typeName: "shape";
  parentId: string;
  x: number;
  y: number;
  meta?: { ppmDesktopSourceId?: string };
};

function importedShapes(board: BoardSnapshot): Map<string, ImportedShape> {
  return new Map(
    Object.values(board.snapshot?.document.store ?? {})
      .filter(
        (record): record is ImportedShape =>
          record.typeName === "shape" &&
          "meta" in record &&
          typeof record.meta === "object" &&
          record.meta !== null &&
          "ppmDesktopSourceId" in record.meta &&
          typeof record.meta.ppmDesktopSourceId === "string"
      )
      .map((shape) => [shape.meta?.ppmDesktopSourceId ?? "", shape])
  );
}

test("nested desktop group, frame, notes and arrow survive import and reload", async ({ browser }) => {
  test.setTimeout(90_000);
  if (!workspaceSlug) throw new Error("Missing isolated AF1.2 workspace slug.");
  const { context, page } = await signIn(browser);
  try {
    const name = `AF1.2 hierarchy ${Date.now().toString(36)}`;
    const response = await page.request.post(boardsURL(), { data: { name, client_operation_id: crypto.randomUUID() } });
    expect(response.status()).toBe(201);
    const board: TestBoard = await response.json();
    await page.goto(`/${workspaceSlug}/projects/${projectId}/brain/`);
    await activateBoard(page, board);
    await expect(page.locator('.ppm-canvas-workspace__editor[data-active="true"] .ppm-canvas-shell')).toHaveAttribute(
      "data-ppm-canvas-mode",
      "edit"
    );
    await page.locator('.ppm-canvas-workspace__editor[data-active="true"] input[type="file"]').setInputFiles({
      name: "af12-hierarchy.flow.json",
      mimeType: "application/json",
      buffer: Buffer.from(syntheticDesktopHierarchyFlow()),
    });
    const preview = page.locator('.ppm-canvas-workspace__editor[data-active="true"] [role="dialog"]');
    await expect(preview).toContainText("5");
    await preview.locator("button").first().click();
    await expect
      .poll(async () => importedShapes(await readBoard(page, board.board_id)).size, { timeout: 60_000 })
      .toBe(5);

    const assertHierarchy = async () => {
      const shapes = importedShapes(await readBoard(page, board.board_id));
      const group = shapes.get("shape:hierarchy-group");
      const frame = shapes.get("shape:hierarchy-frame");
      const note = shapes.get("shape:hierarchy-note");
      const sibling = shapes.get("shape:hierarchy-sibling");
      const arrow = shapes.get("shape:hierarchy-arrow");
      expect(group).toBeDefined();
      expect(frame?.parentId).toBe(group?.id);
      expect(note?.parentId).toBe(frame?.id);
      expect(sibling?.parentId).toBe(group?.id);
      expect(arrow?.parentId).toBe(frame?.id);
      expect(frame).toMatchObject({ x: 50, y: 60 });
      expect(note).toMatchObject({ x: 20, y: 30 });
      expect(arrow).toMatchObject({ x: 15, y: 170 });
    };
    await assertHierarchy();
    await page.reload();
    await activateBoard(page, board);
    await assertHierarchy();
  } finally {
    await context.close();
  }
});

test("300 synthetic shapes remain usable with five open board tabs", async ({ browser }) => {
  test.setTimeout(180_000);
  if (!workspaceSlug || !workspaceId || !projectId) throw new Error("Missing isolated AF1.2 project configuration.");
  const { context, page } = await signIn(browser);
  try {
    const fixtureBoards = await ensureFixtureBoards(page);
    const largeBoard = fixtureBoards[0];
    if (!largeBoard) throw new Error("Missing synthetic large board.");
    await page.goto(`/${workspaceSlug}/projects/${projectId}/brain/`);
    await expect(page.locator('.ppm-canvas-workspace__editor[data-active="true"] [role="application"]')).toBeVisible();
    await activateBoard(page, largeBoard);

    const beforeImport = await readBoard(page, largeBoard.board_id);
    if (countShapes(beforeImport) === 0) {
      await page.locator('.ppm-canvas-workspace__editor[data-active="true"] input[type="file"]').setInputFiles({
        name: "af12-performance.flow.json",
        mimeType: "application/json",
        buffer: Buffer.from(syntheticDesktopFlow()),
      });
      const preview = page.locator('.ppm-canvas-workspace__editor[data-active="true"] [role="dialog"]');
      await expect(preview).toContainText("300");
      await preview.locator("button").first().click();
      await expect
        .poll(async () => countShapes(await readBoard(page, largeBoard.board_id)), { timeout: 60_000 })
        .toBe(300);
    } else {
      expect(countShapes(beforeImport)).toBe(300);
    }

    const initialLoad = Date.now();
    await page.reload();
    await expect(page.locator('.ppm-canvas-workspace__editor[data-active="true"] [role="application"]')).toBeVisible();
    await activateBoard(page, largeBoard);
    await expect(
      page.locator('.ppm-canvas-workspace__editor[data-active="true"] .ppm-canvas-status__notice')
    ).toHaveAttribute("data-status", "saved");
    const loadMs = Date.now() - initialLoad;

    const switchMs: number[] = [];
    for (const board of fixtureBoards.slice(1)) {
      const startedAt = Date.now();
      // Tab navigation is a user sequence, so parallelizing these clicks would invalidate the measurement.
      // oxlint-disable-next-line eslint/no-await-in-loop
      await activateBoard(page, board);
      switchMs.push(Date.now() - startedAt);
    }
    await expect(page.getByRole("tab")).toHaveCount(5);
    const returnStartedAt = Date.now();
    await page.getByRole("tab", { name: largeBoard.name }).click();
    await expect(page.getByRole("tab", { name: largeBoard.name })).toHaveAttribute("aria-selected", "true");
    switchMs.push(Date.now() - returnStartedAt);

    const editor = page.locator('.ppm-canvas-workspace__editor[data-active="true"]');
    await page.getByRole("button", { name: /Приблизить|Zoom in/ }).click();
    await page.getByRole("button", { name: /Отдалить|Zoom out/ }).click();
    const canvasBounds = await editor.locator('[role="application"]').boundingBox();
    if (!canvasBounds) throw new Error("Active Canvas is not measurable.");
    await page.keyboard.down("Space");
    await page.mouse.move(canvasBounds.x + 300, canvasBounds.y + 300);
    await page.mouse.down();
    await page.mouse.move(canvasBounds.x + 450, canvasBounds.y + 350, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up("Space");
    await expect(editor.locator('[role="application"]')).toBeVisible();
    expect(countShapes(await readBoard(page, largeBoard.board_id))).toBe(300);

    const switcher = page.locator(".ppm-canvas-board-switcher");
    await switcher.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: /Доски|Boards/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: /Доски|Boards/ })).toHaveCount(0);
    await expect(switcher).toBeFocused();

    console.info(
      `AF1.2 local Canvas baseline: 300 shapes, 5 tabs, reload=${loadMs}ms, switches=${switchMs.join(",")}ms`
    );
  } finally {
    await context.close();
  }
});
