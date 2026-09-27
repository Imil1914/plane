import { Buffer } from "node:buffer";
import type { APIResponse, Browser, BrowserContext, Page, TestInfo } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { isPpmProjectAskEnabled } from "@ppm/canvas";

type DemoRole = "OWNER" | "ROBOT_MEMBER" | "BIO_MEMBER" | "ROBOT_VIEWER" | "OUTSIDER";

type DemoProject = {
  id: string;
  identifier: string;
  workspace?: string;
  workspace_id?: string;
};

type DemoIds = {
  bioProjectId: string;
  robotProjectId: string;
  workspaceId: string;
  workspaceSlug: string;
};

type CanvasRecord = {
  id: string;
  props?: { node?: string };
  type: string;
  typeName: string;
  x?: number;
  y?: number;
};

type CanvasResponse = {
  bindings: Array<{
    entity_id: string;
    shape_id: string;
    source: {
      display: { state?: { id: string; name: string }; title: string };
    };
  }>;
  snapshot: { document: { store: Record<string, CanvasRecord> } } | null;
  version: number;
};

type BrainOverview = {
  sources: Array<{
    index_state: string;
    source_id: string;
    source_type: string;
    title: string;
  }>;
};

const runId = (process.env.PPM_E2E_RUN_ID ?? new Date().toISOString().replace(/\D/g, "").slice(0, 14)).slice(0, 24);
const workItemTitle = `E2E ROBOT ${runId}`;
const noteTitle = `E2E-${runId}.md`;
const folderTitle = `E2E-${runId}`;
const pdfTitle = `E2E-${runId}.pdf`;
const noteMarker = `E2E-NOTE-${runId}`;
const pdfMarker = `E2E-PDF-${runId}`;

let ownerContext: BrowserContext;
let ownerPage: Page;
let demo: DemoIds;

// RC-1: the browser gate runs system Chrome through the chromium engine, like the AF1.2 specs.
if (process.env.PPM_E2E_BROWSER_CHANNEL) {
  test.use({ launchOptions: { channel: process.env.PPM_E2E_BROWSER_CHANNEL } });
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the PPM demo browser gate.`);
  return value;
}

function roleCredentials(role: DemoRole) {
  return {
    email: requiredEnv(`PPM_DEMO_${role}_EMAIL`),
    password: requiredEnv(`PPM_DEMO_${role}_PASSWORD`),
  };
}

// RC-1: API calls go to the API origin. The browser gate serves web and API on different ports; behind the RC
// proxy they share one origin, and PPM_E2E_API_BASE_URL may stay unset.
function apiUrl(path: string) {
  return new URL(path, process.env.PPM_E2E_API_BASE_URL?.trim() || requiredEnv("PPM_E2E_BASE_URL")).href;
}

async function jsonResponse<T>(response: APIResponse, label: string): Promise<T> {
  if (!response.ok()) throw new Error(`${label} returned HTTP ${response.status()}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function login(page: Page, role: DemoRole) {
  const credentials = roleCredentials(role);
  await page.goto("/sign-in");
  await expect(page.locator("html")).toHaveAttribute("data-ppm-brand", "enabled");
  await page.locator("#email").fill(credentials.email);
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await expect(page.locator("#password")).toBeVisible();
  await page.locator("#password").fill(credentials.password);
  await page.getByRole("button", { name: /Продолжить|Открыть пространство/ }).click();
  await expect
    .poll(async () => (await page.request.get(apiUrl("/api/users/me/"))).status(), {
      timeout: 30_000,
    })
    .toBe(200);
  // RC-1 (lane G): the password form is a native POST answered by a redirect to "/" once the session cookie is set;
  // the app then routes on to the workspace. A page.goto racing that redirect or the landing page's own start-up
  // navigation is aborted (Firefox NS_BINDING_ABORTED / NS_ERROR_FAILURE, WebKit "interrupted by another
  // navigation"), so wait until the app has left "/" (where the sign-in form also lives) and has settled.
  await page.waitForURL((url) => url.pathname !== "/" && !url.pathname.startsWith("/sign-in"));
  await page.waitForLoadState("networkidle");
}

async function createRoleContext(browser: Browser, role: DemoRole) {
  const context = await browser.newContext({
    baseURL: requiredEnv("PPM_E2E_BASE_URL"),
    ignoreHTTPSErrors: process.env.PPM_E2E_IGNORE_HTTPS_ERRORS === "1",
    locale: "ru-RU",
    reducedMotion: "reduce",
    timezoneId: "Europe/Moscow",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  await login(page, role);
  return { context, page };
}

async function discoverDemo(page: Page): Promise<DemoIds> {
  // RC-1: the browser gate seeds its own ROBOT/BIO space (seed_ppm_demo_gate) next to the AF1.2 fixture workspace.
  const workspaceSlug = process.env.PPM_DEMO_WORKSPACE_SLUG?.trim() || requiredEnv("PPM_E2E_WORKSPACE_SLUG");
  const response = await page.request.get(apiUrl(`/api/workspaces/${workspaceSlug}/projects/`));
  const payload = await jsonResponse<DemoProject[] | { results: DemoProject[] }>(response, "Project discovery");
  const projects = Array.isArray(payload) ? payload : payload.results;
  const robot = projects.find((project) => project.identifier.toUpperCase() === "ROBOT");
  const bio = projects.find((project) => project.identifier.toUpperCase() === "BIO");
  if (!robot || !bio) throw new Error("The seeded ROBOT and BIO projects are required.");
  const workspaceId = robot.workspace ?? robot.workspace_id;
  if (!workspaceId) throw new Error("The project response did not contain the demo workspace ID.");
  return {
    bioProjectId: bio.id,
    robotProjectId: robot.id,
    workspaceId,
    workspaceSlug,
  };
}

function projectPath(projectId: string, section: "brain" | "knowledge" | "overview") {
  return `/${demo.workspaceSlug}/projects/${projectId}/${section}`;
}

function ppmApi(projectId: string, suffix: string) {
  return apiUrl(`/api/ppm/v1/workspaces/${demo.workspaceId}/projects/${projectId}/${suffix}`);
}

async function getCanvas(page: Page, projectId = demo.robotProjectId) {
  return jsonResponse<CanvasResponse>(await page.request.get(ppmApi(projectId, "canvas/")), "Canvas read");
}

async function waitForCanvasVersion(page: Page, previousVersion: number) {
  await expect
    .poll(async () => (await getCanvas(page)).version, {
      message: "Canvas autosave did not create a new version",
    })
    .toBeGreaterThan(previousVersion);
  await expect(page.getByText("Все изменения сохранены", { exact: true })).toBeVisible();
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ animations: "disabled", fullPage: true, path });
  await testInfo.attach(name, { contentType: "image/png", path });
}

async function attachJson(testInfo: TestInfo, name: string, value: unknown) {
  await testInfo.attach(name, {
    body: Buffer.from(`${JSON.stringify(value, null, 2)}\n`),
    contentType: "application/json",
  });
}

async function drawConnection(page: Page) {
  // AF2.1 final-fix I-2: the v2 note (format "markdown") only renders `input.ppm-canvas-node__title` while it is
  // tldraw's local editing shape (note-markdown.tsx NoteCardV2) — by the time this runs the note has left edit mode,
  // so it is addressed the same way as the rest of the demo: the card's own `ppm-canvas-node--note` kind class
  // (shape.tsx:290), scoped to the one note that carries this run's body marker.
  const noteCard = page.locator(".ppm-canvas-node--note").filter({ hasText: noteMarker });
  const workItemCard = page.locator(".ppm-work-item-card").filter({ hasText: workItemTitle });
  const noteBox = await noteCard.boundingBox();
  const workItemBox = await workItemCard.boundingBox();
  if (!noteBox || !workItemBox) throw new Error("Canvas nodes must be visible before drawing a connection.");

  // AF2.1: the v2 rail tool «Связь» (canvas-rail.tsx, canvas.rail.connection) arms tldraw's arrow tool.
  await page
    .getByRole("complementary", { name: "Инструменты холста" })
    .getByRole("button", { name: "Связь", exact: true })
    .click();
  await page.mouse.move(noteBox.x + noteBox.width - 4, noteBox.y + noteBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(workItemBox.x + 4, workItemBox.y + workItemBox.height / 2, { steps: 12 });
  await page.mouse.up();
}

function buildPdf(text: string): Buffer {
  const safeText = text.replace(/[\\()]/g, (value) => `\\${value}`);
  const stream = `BT /F1 12 Tf 72 720 Td (${safeText}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  const chunks = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets = [0];
  let size = chunks[0].length;
  for (const [index, object] of objects.entries()) {
    offsets.push(size);
    const chunk = Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`, "latin1");
    chunks.push(chunk);
    size += chunk.length;
  }
  const xrefOffset = size;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  ].join("");
  chunks.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(chunks);
}

function canvasRecords(canvas: CanvasResponse) {
  return Object.values(canvas.snapshot?.document.store ?? {});
}

// The Brain titles a Work Item source "ROBOT-12 · <name>"; Vault files keep their own name.
function isSourceFor(source: { title: string }, title: string) {
  return source.title === title || source.title.endsWith(` · ${title}`);
}

async function waitForReadySources(page: Page, expectedTitles: string[]) {
  const overviewUrl = ppmApi(demo.robotProjectId, "knowledge/sources/");
  await expect
    .poll(
      async () => {
        const overview = await jsonResponse<BrainOverview>(await page.request.get(overviewUrl), "Brain overview");
        return expectedTitles.every((title) =>
          overview.sources.some((source) => isSourceFor(source, title) && source.index_state === "ready")
        );
      },
      {
        message: `Sources did not become ready: ${expectedTitles.join(", ")}`,
        timeout: 120_000,
      }
    )
    .toBe(true);
}

// RC-1: not serial — a failing scenario must not hide the independent ones after it. With one worker the tests still
// run in file order; after a failure Playwright starts a new worker and beforeAll signs the owner in again.
test.describe("PPM demo D0 browser release gate", () => {
  test.beforeAll(async ({ browser }) => {
    ownerContext = await browser.newContext({
      baseURL: requiredEnv("PPM_E2E_BASE_URL"),
      ignoreHTTPSErrors: process.env.PPM_E2E_IGNORE_HTTPS_ERRORS === "1",
      locale: "ru-RU",
      reducedMotion: "reduce",
      timezoneId: "Europe/Moscow",
      viewport: { width: 1440, height: 1000 },
    });
    ownerPage = await ownerContext.newPage();
    await login(ownerPage, "OWNER");
    demo = await discoverDemo(ownerPage);
  });

  test.afterAll(async () => {
    await ownerContext?.close();
  });

  test.afterEach(async ({ browser: _ }, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus || !ownerPage || ownerPage.isClosed()) return;
    const safeTitle = testInfo.title
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase();
    await screenshot(ownerPage, testInfo, `failure-${safeTitle}`).catch(() => undefined);
  });

  test("E1: one login, PPM brand, and source/legal page", async ({ browser: _ }, testInfo) => {
    await ownerPage.goto(projectPath(demo.robotProjectId, "overview"));
    await expect(
      ownerPage.getByRole("heading", {
        name: "ROBOT — Манипулятор",
        exact: true,
      })
    ).toBeVisible();
    await expect(ownerPage.locator("html")).toHaveAttribute("lang", "ru");
    await expect(ownerPage.locator('meta[name="application-name"]')).toHaveAttribute("content", "PPM");
    // The app shell renders its own <main> around the page's <main>; the outer one covers the whole screen.
    await expect(ownerPage.locator("main").first()).not.toContainText(/\bPlane\b/);
    await screenshot(ownerPage, testInfo, "e1-overview-dark");

    await ownerPage.goto("/about/open-source");
    await expect(ownerPage.locator("body")).toContainText("PPM");
    await expect(ownerPage.getByRole("heading", { name: "Система управления проектами PPM" })).toBeVisible();
    await expect(ownerPage.locator("body")).not.toContainText(/\bPlane\b/);
    await screenshot(ownerPage, testInfo, "e1-source-legal");

    await ownerPage.goto("/about/brand-foundation");
    await expect(ownerPage.getByRole("heading", { name: "PPM brand foundation" })).toBeVisible();
    await expect(ownerPage.getByRole("heading", { name: "Light" })).toBeVisible();
    await expect(ownerPage.getByRole("heading", { name: "Graphite" })).toBeVisible();
    await expect(ownerPage.getByLabel("Название проекта, тема Light")).toHaveValue("Новый проект");
    await expect(ownerPage.getByLabel("Название проекта, тема Graphite")).toHaveValue("Новый проект");
    await ownerPage.getByRole("button", { name: "Открыть Dialog" }).first().click();
    await expect(ownerPage.getByRole("dialog")).toContainText("PPM Dialog");
    await screenshot(ownerPage, testInfo, "i0-2-brand-foundation-light-graphite");
    await ownerPage.getByRole("button", { name: "Закрыть" }).click();
  });

  test("E2-E7: Work Item, Canvas, Vault, PDF, and grounded Ask Project", async ({ browser: _ }, testInfo) => {
    // Canvas, Vault and a Brain index round trip (up to 120 s) in one scenario.
    test.setTimeout(300_000);
    await ownerPage.goto(projectPath(demo.robotProjectId, "brain"));
    await expect(ownerPage.getByRole("main", { name: "Холст проекта" })).toBeVisible();
    const initialCanvas = await getCanvas(ownerPage);

    await ownerPage.getByRole("button", { name: "Документы и текст", exact: true }).click();
    await ownerPage.getByRole("menuitem", { name: /^Заметка/ }).click();
    // AF2.1 final-fix I-2: a new v2 note opens straight in edit mode (editor.setEditingShape, the controller's
    // common solution) — its title field is aria-label "Заголовок" (canvas.note_title_placeholder, note-markdown.tsx
    // :105-108), not the old v1 "Новая заметка" placeholder that every native note card showed regardless of edit
    // state. The body field's aria-label ("Напишите заметку в Markdown…") is unchanged — the same key
    // (canvas.note_body_placeholder) already labelled it before AF2.1, and old plain-format notes still on the
    // long-lived ROBOT demo board render it too (NativeNodeCard, shape.tsx:781-791, always — not gated by edit
    // state) — final-fix round 2, m-1: an unscoped query for that name is ambiguous (Playwright's strict mode) as
    // soon as such a note exists. `.ppm-note-card[data-editing]` only the v2 NoteCardV2 renders (note-markdown.tsx),
    // and only while `editing` — scoping to it addresses this note's own fields regardless of what else is on the
    // board. Escaping afterwards leaves the note as the rendered card (`.ppm-canvas-node--note`, shape.tsx:290) the
    // rest of this test (drag, drawConnection, reload) addresses by its body marker text — see drawConnection above.
    const editingNote = ownerPage.locator(".ppm-note-card[data-editing]");
    await editingNote.getByRole("textbox", { name: "Заголовок" }).fill(noteTitle);
    await editingNote.getByRole("textbox", { name: "Напишите заметку в Markdown…" }).fill(noteMarker);
    await ownerPage.keyboard.press("Escape");

    await ownerPage.getByRole("button", { name: "Из проекта", exact: true }).click();
    await ownerPage.getByRole("menuitem", { name: /^Задача/ }).click();
    await ownerPage.getByPlaceholder("Поиск по названию или идентификатору…").fill(workItemTitle);
    await ownerPage.getByRole("button", { name: new RegExp(`Создать задачу.*${runId}`) }).click();
    const workItemCard = ownerPage.locator(".ppm-work-item-card").filter({ hasText: workItemTitle });
    await expect(workItemCard).toBeVisible();

    // RC-1 regression for the RC-F1 fixes, with the gate's Celery worker running. D-1: a Work Item with an assignee
    // used to crash its save (500) and its Brain indexing — assign the seeded ROBOT member from the card. D-2: the card
    // version was the Work Item's updated_at, which the worker's issue_activity moves right after every change, so a
    // second change from the same card load got 409 and silently reverted — change the status twice, the second time
    // only after the worker has logged the first change.
    // The card shows up before its binding is saved with the board.
    const boundWorkItemId = async () =>
      (await getCanvas(ownerPage)).bindings.find((item) => item.source.display.title === workItemTitle)?.entity_id;
    await expect.poll(boundWorkItemId, { message: "The new Work Item is not bound to the Canvas" }).toBeTruthy();
    const workItemId = await boundWorkItemId();
    if (!workItemId) throw new Error("The new Work Item is not bound to the Canvas.");
    const assigneeSelect = workItemCard.getByLabel("Исполнители");
    const teammateId = await assigneeSelect.locator("option", { hasText: "Участник ROBOT" }).getAttribute("value");
    if (!teammateId) throw new Error("The seeded ROBOT member is not offered as an assignee.");
    await assigneeSelect.selectOption([teammateId]);
    await expect(assigneeSelect).toHaveValues([teammateId]);

    const stateSelect = workItemCard.getByLabel("Статус");
    const initialState = await stateSelect.inputValue();
    const states = await stateSelect.locator("option").evaluateAll((options) =>
      options.map((option) => ({
        label: option.textContent?.trim() ?? "",
        value: (option as HTMLOptionElement).value,
      }))
    );
    const [firstState, targetState] = states.filter((state) => state.value && state.value !== initialState);
    if (!firstState || !targetState) throw new Error("The demo project must have at least three workflow states.");
    await stateSelect.selectOption(firstState.value);
    await expect(stateSelect).toHaveValue(firstState.value);
    const historyUrl = apiUrl(
      `/api/workspaces/${demo.workspaceSlug}/projects/${demo.robotProjectId}/issues/${workItemId}/history/?activity_type=issue-property`
    );
    await expect
      .poll(
        async () =>
          (
            await jsonResponse<Array<{ field?: string | null }>>(await ownerPage.request.get(historyUrl), "History")
          ).some((activity) => activity.field === "state"),
        { message: "The Celery worker did not log the first status change", timeout: 30_000 }
      )
      .toBe(true);
    await stateSelect.selectOption(targetState.value);
    await expect(stateSelect).toHaveValue(targetState.value);
    await expect
      .poll(
        async () =>
          (await getCanvas(ownerPage)).bindings.find((item) => item.entity_id === workItemId)?.source.display.state?.id,
        { message: "The second status change from the same card was not saved" }
      )
      .toBe(targetState.value);

    const noteCardBeforeDrag = ownerPage.locator(".ppm-canvas-node--note").filter({ hasText: noteMarker });
    const noteBox = await noteCardBeforeDrag.boundingBox();
    if (!noteBox) throw new Error("The new Canvas note is not visible.");
    await ownerPage.mouse.move(noteBox.x + 8, noteBox.y + 8);
    await ownerPage.mouse.down();
    await ownerPage.mouse.move(noteBox.x - 260, noteBox.y + 8, { steps: 12 });
    await ownerPage.mouse.up();
    await drawConnection(ownerPage);

    await expect
      .poll(async () => canvasRecords(await getCanvas(ownerPage)).filter((record) => record.type === "arrow").length, {
        message: "The visual link between the note and Work Item was not persisted",
      })
      .toBeGreaterThan(0);
    await waitForCanvasVersion(ownerPage, initialCanvas.version);

    const canvasBeforeReload = await getCanvas(ownerPage);
    const binding = canvasBeforeReload.bindings.find((item) => item.source.display.title === workItemTitle);
    expect(binding, "The Work Item binding must be active after Canvas save").toBeDefined();
    const beforeRecords = canvasRecords(canvasBeforeReload);
    const savedNote = beforeRecords.find((record) => record.props?.node?.includes(noteTitle));
    const savedWorkItem = beforeRecords.find((record) => record.id === binding?.shape_id);
    const savedArrowCount = beforeRecords.filter((record) => record.type === "arrow").length;
    expect(savedNote).toBeDefined();
    expect(savedWorkItem).toBeDefined();

    await ownerPage.reload();
    // A reload starts with nothing in tldraw's local editing state, so the note is back to its rendered card
    // (note-markdown.tsx h3.ppm-note-card__title) rather than the input a fresh addressable page would open into.
    await expect(ownerPage.getByRole("heading", { name: noteTitle, exact: true })).toBeVisible();
    const reloadedCanvas = await getCanvas(ownerPage);
    const reloadedRecords = canvasRecords(reloadedCanvas);
    expect(reloadedRecords.filter((record) => record.type === "arrow")).toHaveLength(savedArrowCount);
    expect(reloadedRecords.find((record) => record.id === savedNote?.id)).toMatchObject({
      x: savedNote?.x,
      y: savedNote?.y,
    });
    expect(reloadedRecords.find((record) => record.id === savedWorkItem?.id)).toMatchObject({
      x: savedWorkItem?.x,
      y: savedWorkItem?.y,
    });
    const reloadedState = ownerPage
      .locator(".ppm-work-item-card")
      .filter({ hasText: workItemTitle })
      .getByLabel("Статус");
    await expect(reloadedState).toHaveValue(targetState.value);
    await screenshot(ownerPage, testInfo, "e2-e3-canvas-persisted");

    await ownerPage.goto(projectPath(demo.robotProjectId, "knowledge"));
    await expect(ownerPage.getByRole("main", { name: "Хранилище" })).toBeVisible();
    await ownerPage.getByRole("button", { name: "Новая папка", exact: true }).click();
    await ownerPage.getByLabel("Название папки").fill(folderTitle);
    await ownerPage.getByRole("button", { name: "Создать", exact: true }).click();
    await ownerPage
      .getByRole("tree", { name: "Хранилище проекта" })
      .getByRole("treeitem", { name: folderTitle, exact: true })
      .last()
      .click();

    await ownerPage.getByRole("button", { name: "Новый Markdown", exact: true }).click();
    // UX0.2: one create dialog for folders and materials — «Название материала» plus «Папка назначения», which
    // defaults to the folder selected in the tree.
    await ownerPage.getByLabel("Название материала").fill(noteTitle);
    await ownerPage.getByRole("button", { name: "Создать", exact: true }).click();
    // The editor is editable before its content arrives, and the late load replaces what was typed (reported as D-3
    // by RC-1); type only once the header shows the loaded version 1 ("Версия 1 · 0 Б"; the history card says
    // "Версия 1 · текущая").
    await expect(ownerPage.getByText(/^Версия 1 · \d/)).toBeVisible();
    const markdown = `# Проверка ${runId}\n\n${noteMarker}\n\nСвязанный материал: [[${pdfTitle.replace(/\.pdf$/, "")}]].\n`;
    await ownerPage.getByRole("textbox", { name: "Редактор Markdown" }).fill(markdown);
    await ownerPage.getByRole("button", { name: "Сохранить новую версию", exact: true }).click();
    await expect(ownerPage.getByText(/^Версия 2 · \d/)).toBeVisible();

    await ownerPage.reload();
    await ownerPage
      .getByRole("tree", { name: "Хранилище проекта" })
      .getByRole("treeitem", { name: noteTitle, exact: true })
      .click();
    await expect(ownerPage.getByRole("textbox", { name: "Редактор Markdown" })).toHaveValue(markdown);

    await ownerPage.locator('input[type="file"][accept*="pdf"]').setInputFiles({
      buffer: buildPdf(`${pdfMarker} verified browser E2E source`),
      mimeType: "application/pdf",
      name: pdfTitle,
    });
    await expect(ownerPage.getByRole("heading", { name: pdfTitle, exact: true })).toBeVisible();
    await expect(ownerPage.getByTitle(`Предпросмотр PDF: ${pdfTitle}`)).toBeVisible();
    await screenshot(ownerPage, testInfo, "e5-e6-vault-pdf");

    const beforeVaultProjection = await getCanvas(ownerPage);
    await ownerPage.getByRole("link", { name: "На холст «Мозг проекта»", exact: true }).click();
    // AF2.1: a Vault PDF lands on the canvas as a "pdf" media card bound to the Vault file (not a vault_file_ref).
    const vaultProjection = ownerPage.locator('[data-ppm-canvas-node-kind="pdf"]').filter({ hasText: pdfTitle });
    await expect(vaultProjection).toBeVisible();
    await waitForCanvasVersion(ownerPage, beforeVaultProjection.version);
    const canvasWithVaultProjection = await getCanvas(ownerPage);
    const vaultProjectionRecord = canvasRecords(canvasWithVaultProjection).find(
      (record) => record.type === "ppm-canvas-node" && record.props?.node?.includes(pdfTitle)
    );
    expect(vaultProjectionRecord, "The PDF projection must be stored on Canvas").toBeDefined();
    const vaultProjectionNode = JSON.parse(vaultProjectionRecord?.props?.node ?? "{}") as Record<string, unknown>;
    expect(vaultProjectionNode).toMatchObject({
      binding: { entity_type: "vault_file" },
      kind: "pdf",
      title: pdfTitle,
    });
    expect(JSON.stringify(vaultProjectionNode)).not.toContain(pdfMarker);
    expect(vaultProjectionNode).not.toHaveProperty("content");
    expect(vaultProjectionNode).not.toHaveProperty("blob");

    // The Brain index moved from the Vault page to the canvas panel «Найти в проекте» → «Источники проекта».
    await ownerPage.goto(projectPath(demo.robotProjectId, "brain"));
    await ownerPage.getByRole("button", { name: /^(Найти в проекте|Спросить проект)$/ }).click();
    await ownerPage
      .getByRole("dialog", { name: /^(Найти в проекте|Спросить проект)$/ })
      .getByRole("region", { name: "Источники проекта" })
      .getByRole("button", { name: "Обновить индекс", exact: true })
      .click();
    await waitForReadySources(ownerPage, [workItemTitle, noteTitle, pdfTitle]);
    const readyBrain = await jsonResponse<BrainOverview>(
      await ownerPage.request.get(ppmApi(demo.robotProjectId, "knowledge/sources/")),
      "Ready Brain overview"
    );
    const requiredSource = (title: string, sourceType: string) => {
      const source = readyBrain.sources.find(
        (candidate) => isSourceFor(candidate, title) && candidate.source_type === sourceType
      );
      if (!source) throw new Error(`Ready ${sourceType} source is missing: ${title}`);
      return source;
    };
    const workItemSource = requiredSource(workItemTitle, "work_item");
    // Markdown and PDF are both Vault files for the Brain index (source_type "vault_file").
    const markdownSource = requiredSource(noteTitle, "vault_file");
    const pdfSource = requiredSource(pdfTitle, "vault_file");
    const expectedCitations = [
      {
        sourceId: workItemSource.source_id,
        sourceType: workItemSource.source_type,
        title: workItemTitle,
        url: `/${demo.workspaceSlug}/projects/${demo.robotProjectId}/issues/${workItemSource.source_id}`,
      },
      {
        sourceId: markdownSource.source_id,
        sourceType: markdownSource.source_type,
        title: noteTitle,
        url: `/${demo.workspaceSlug}/projects/${demo.robotProjectId}/knowledge?entry_id=${markdownSource.source_id}`,
      },
      {
        sourceId: pdfSource.source_id,
        sourceType: pdfSource.source_type,
        title: pdfTitle,
        url: `/${demo.workspaceSlug}/projects/${demo.robotProjectId}/knowledge?entry_id=${pdfSource.source_id}`,
      },
    ];

    // The canvas page hosts both the Ask panel and the projection-removal step below.
    await ownerPage.goto(projectPath(demo.robotProjectId, "brain"));
    // Generated answers ship only with PPM_PROJECT_ASK_ENABLED on (same truthy set as the app); without it only
    // the Ask/agents steps are skipped — projection removal and the E2–E7 evidence below still run.
    const projectAskEnabled = isPpmProjectAskEnabled(process.env.PPM_PROJECT_ASK_ENABLED);
    if (!projectAskEnabled) {
      // RC-1, E7 without AI: the non-generative project search finds the new Markdown by its unique marker and links
      // to that exact Vault entry.
      await ownerPage.getByRole("button", { name: "Найти в проекте", exact: true }).click();
      const searchPanel = ownerPage.getByRole("dialog", { name: "Найти в проекте" });
      await searchPanel.getByRole("textbox", { name: "Найти в проекте" }).fill(noteMarker);
      await searchPanel.getByRole("button", { name: "Найти источники", exact: true }).click();
      const foundNote = searchPanel
        .getByRole("region", { name: "Результаты поиска" })
        .locator("article")
        .filter({ hasText: noteTitle });
      await expect(foundNote).toBeVisible({ timeout: 30_000 });
      await expect(foundNote.getByRole("link", { name: "Открыть источник" })).toHaveAttribute(
        "href",
        `/${demo.workspaceSlug}/projects/${demo.robotProjectId}/knowledge?entry_id=${markdownSource.source_id}`
      );
      await screenshot(ownerPage, testInfo, "e7-project-search");
      await searchPanel.getByRole("button", { name: "Закрыть", exact: true }).click();
    }
    if (projectAskEnabled) {
      await ownerPage.getByRole("button", { name: "Спросить проект", exact: true }).click();
      const askPanel = ownerPage.getByRole("region", { name: "Спросить проект" });
      await askPanel
        .getByPlaceholder("Спросите о проекте, его задачах или материалах…")
        .fill(`Собери подтверждения для ${workItemTitle}, ${noteMarker} и ${pdfMarker}.`);
      await askPanel.getByRole("button", { name: "Спросить", exact: true }).click();
      await expect(askPanel.locator(".ppm-ask-panel__result")).toBeVisible({
        timeout: 120_000,
      });
      await expect(askPanel).toContainText(workItemTitle);
      await expect(askPanel).toContainText(noteTitle);
      await expect(askPanel).toContainText(pdfTitle);
      const citations = askPanel.locator(".ppm-ask-panel__citations a");
      await expect.poll(async () => citations.count()).toBeGreaterThanOrEqual(3);
      const citationLinks = await citations.evaluateAll((links) =>
        links.map((link) => ({
          href: (link as HTMLAnchorElement).getAttribute("href") ?? "",
          title:
            link
              .querySelector("span")
              ?.textContent?.replace(/^\d+\.\s*/, "")
              .trim() ?? "",
        }))
      );
      await Promise.all(
        expectedCitations.map(async (expectedCitation) => {
          expect(citationLinks, `Citation is missing for ${expectedCitation.sourceType}`).toContainEqual({
            href: expectedCitation.url,
            title: expectedCitation.title,
          });
          const destination = await ownerPage.request.get(expectedCitation.url);
          expect(destination.status(), `Citation destination is not reachable: ${expectedCitation.sourceType}`).toBe(
            200
          );
        })
      );
      const beforeAnswerSave = await getCanvas(ownerPage);
      await askPanel.getByRole("button", { name: "Сохранить на холсте", exact: true }).click();
      await expect(askPanel.getByRole("button", { name: "Добавлено на холст", exact: true })).toBeVisible();
      await waitForCanvasVersion(ownerPage, beforeAnswerSave.version);
      await screenshot(ownerPage, testInfo, "e7-grounded-answer");
    }

    const beforeProjectionRemoval = await getCanvas(ownerPage);
    await ownerPage
      .locator(".ppm-work-item-card")
      .filter({ hasText: workItemTitle })
      .getByRole("button", { name: "Убрать с холста", exact: true })
      // The PDF card added above lands at the viewport centre, on top of this card, and takes the pointer; press the
      // button itself rather than whatever is drawn over it.
      .dispatchEvent("click");
    await expect(ownerPage.locator(".ppm-work-item-card").filter({ hasText: workItemTitle })).toHaveCount(0);
    await waitForCanvasVersion(ownerPage, beforeProjectionRemoval.version);
    const search = await jsonResponse<{
      results: Array<{ display: { title: string } }>;
    }>(
      await ownerPage.request.get(
        `${ppmApi(demo.robotProjectId, "projections/search/")}?q=${encodeURIComponent(workItemTitle)}`
      ),
      "Work Item search after projection removal"
    );
    expect(search.results.some((result) => result.display.title === workItemTitle)).toBe(true);
    const finalCanvas = await getCanvas(ownerPage);
    const finalBrain = await jsonResponse<BrainOverview>(
      await ownerPage.request.get(ppmApi(demo.robotProjectId, "knowledge/sources/")),
      "Final Brain overview"
    );
    await attachJson(testInfo, "e2-e7-api-evidence.json", {
      canvasVersion: finalCanvas.version,
      // Citations are verified (link present, destination reachable) only in the Ask block above.
      citations: projectAskEnabled
        ? expectedCitations.map(({ sourceId, sourceType, title, url }) => ({
            reachable: true,
            sourceId,
            sourceType,
            title,
            url,
          }))
        : [],
      indexedSources: finalBrain.sources
        .filter((source) => [workItemTitle, noteTitle, pdfTitle].some((title) => isSourceFor(source, title)))
        .map((source) => ({
          state: source.index_state,
          title: source.title,
          type: source.source_type,
        })),
      projectAskEnabled,
      projectionRemoved: !finalCanvas.bindings.some((item) => item.source.display.title === workItemTitle),
      runId,
      vaultProjectionContainsBlob: "content" in vaultProjectionNode || "blob" in vaultProjectionNode,
      workItemStillExists: search.results.some((result) => result.display.title === workItemTitle),
    });
  });

  test("E8: viewer UI and ROBOT/BIO isolation", async ({ browser }, testInfo) => {
    // Three more roles sign in through the UI.
    test.setTimeout(120_000);
    const viewer = await createRoleContext(browser, "ROBOT_VIEWER");
    const robotMember = await createRoleContext(browser, "ROBOT_MEMBER");
    const outsider = await createRoleContext(browser, "OUTSIDER");
    try {
      await viewer.page.goto(projectPath(demo.robotProjectId, "brain"));
      await expect(viewer.page.getByText("Холст только для чтения", { exact: true })).toBeVisible();
      // The v2 rail offers no creation groups on a read-only board (as in the AF1.2 guest test).
      await expect(viewer.page.getByRole("button", { name: "Документы и текст", exact: true })).toHaveCount(0);
      await expect(viewer.page.getByRole("button", { name: "Из проекта", exact: true })).toHaveCount(0);
      await screenshot(viewer.page, testInfo, "e8-viewer-read-only");

      await viewer.page.goto(projectPath(demo.robotProjectId, "knowledge"));
      await expect(viewer.page.getByText("Только чтение", { exact: true })).toBeVisible();
      await expect(
        viewer.page.getByRole("button", {
          name: "Новый Markdown",
          exact: true,
        })
      ).toHaveCount(0);

      const robotMemberDenials = await Promise.all(
        ["canvas/", "vault/", "knowledge/sources/"].map((suffix) =>
          robotMember.page.request.get(ppmApi(demo.bioProjectId, suffix))
        )
      );
      expect(robotMemberDenials.every((response) => [403, 404].includes(response.status()))).toBe(true);
      const foreignSearch = await robotMember.page.request.post(ppmApi(demo.robotProjectId, "knowledge/query/"), {
        data: { query: "BIO-ISOLATION-MARKER" },
      });
      expect(foreignSearch.status()).toBe(200);
      const foreignSearchBody = await foreignSearch.text();
      expect(foreignSearchBody).not.toContain("BIO-ISOLATION-MARKER");

      const outsiderDenials = await Promise.all(
        ["canvas/", "vault/", "knowledge/sources/"].map((suffix) =>
          outsider.page.request.get(ppmApi(demo.robotProjectId, suffix))
        )
      );
      expect(outsiderDenials.every((response) => [403, 404].includes(response.status()))).toBe(true);
      await attachJson(testInfo, "e8-isolation-api-evidence.json", {
        bioAccessFromRobotMember: robotMemberDenials.map((response) => response.status()),
        bioMarkerAbsentFromRobotRetrieval: !foreignSearchBody.includes("BIO-ISOLATION-MARKER"),
        robotAccessFromOutsider: outsiderDenials.map((response) => response.status()),
      });
    } finally {
      await Promise.all([viewer.context.close(), robotMember.context.close(), outsider.context.close()]);
    }
  });

  test("visual/a11y: light and dark screenshots, reduced motion, keyboard focus", async ({ browser: _ }, testInfo) => {
    await ownerPage.goto(projectPath(demo.robotProjectId, "overview"));
    expect(await ownerPage.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);

    const captureTheme = async (theme: "dark" | "light") => {
      await ownerPage.evaluate((value) => {
        localStorage.setItem("theme", value);
        document.documentElement.setAttribute("data-theme", value);
      }, theme);
      await expect(ownerPage.locator("html")).toHaveAttribute("data-theme", theme);
      await screenshot(ownerPage, testInfo, `visual-overview-${theme}`);
    };
    await captureTheme("light");
    await captureTheme("dark");

    await expect
      .poll(
        async () => {
          await ownerPage.keyboard.press("Tab");
          return ownerPage.evaluate(() => {
            const element = document.activeElement;
            if (!(element instanceof HTMLElement) || element === document.body) return false;
            const box = element.getBoundingClientRect();
            return box.width > 0 && box.height > 0;
          });
        },
        {
          message: "Keyboard navigation must reach a visible interactive element",
          timeout: 12_000,
        }
      )
      .toBe(true);
  });

  test.skip("E5 follow-up: resolved backlinks and graph are delivered by I1.1", () => undefined);
});
