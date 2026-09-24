import { rm } from "node:fs/promises";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

const baseURL = process.env.PPM_E2E_BASE_URL ?? "http://localhost:3000";
const apiBaseURL = process.env.PPM_E2E_API_BASE_URL ?? baseURL;
const currentUserURL = new URL("/api/users/me/", apiBaseURL).href;
const workspaceSlug = process.env.PPM_E2E_WORKSPACE_SLUG;
const workspaceId = process.env.PPM_E2E_WORKSPACE_ID;
const projectId = process.env.PPM_E2E_PROJECT_ID;
const runId = Date.now().toString(36);
const authenticatedStates = new Map<
  "OWNER" | "MEMBER" | "GUEST" | "GLOBAL",
  Awaited<ReturnType<BrowserContext["storageState"]>>
>();

if (process.env.PPM_E2E_BROWSER_CHANNEL) {
  test.use({ launchOptions: { channel: process.env.PPM_E2E_BROWSER_CHANNEL } });
}

async function hasApiSession(page: Page): Promise<boolean> {
  const response = await page.request.get(currentUserURL);
  return response.status() === 200 && response.headers()["content-type"]?.includes("application/json") === true;
}

async function signIn(browser: Browser, role: "OWNER" | "MEMBER" | "GUEST" | "GLOBAL") {
  const email = process.env[`PPM_E2E_${role}_EMAIL`];
  const password = process.env[`PPM_E2E_${role}_PASSWORD`];
  if (!email || !password) throw new Error(`Missing local ${role} test credentials.`);
  const storageState = authenticatedStates.get(role);
  const context = await browser.newContext({
    baseURL,
    locale: "ru-RU",
    viewport: { width: 1440, height: 900 },
    ...(storageState ? { storageState } : {}),
  });
  const page = await context.newPage();
  if (storageState) {
    if (await hasApiSession(page)) return { context, page };
    authenticatedStates.delete(role);
    await context.close();
    return signIn(browser, role);
  }
  await page.goto("/sign-in");
  await page.locator("#email").fill(email, { timeout: 90_000 });
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /Продолжить|Открыть пространство/ }).click();
  await expect.poll(() => hasApiSession(page)).toBe(true);
  authenticatedStates.set(role, await context.storageState());
  return { context, page };
}

async function openCanvas(page: Page) {
  if (!workspaceSlug || !projectId) throw new Error("Missing isolated AF1.2 project configuration.");
  await page.goto(`/${workspaceSlug}/projects/${projectId}/brain/`);
  await expect(page.getByRole("main", { name: /Холст проекта|Project canvas/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("application", { name: "tldraw" })).toBeVisible({ timeout: 30_000 });
}

async function getCanvas(page: Page): Promise<{
  access: string;
  version: number;
  snapshot: { document: { store: Record<string, unknown> } } | null;
}> {
  if (!workspaceId || !projectId) throw new Error("Missing isolated AF1.2 workspace/project IDs.");
  const response = await page.request.get(
    new URL(`/api/ppm/v1/workspaces/${workspaceId}/projects/${projectId}/canvas/`, apiBaseURL).href
  );
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("application/json");
  return response.json();
}

async function closeContext(context: BrowserContext | undefined) {
  if (context) await context.close();
}

test("project lead and member share one board without reload", async ({ browser }) => {
  let ownerContext: BrowserContext | undefined;
  let memberContext: BrowserContext | undefined;
  try {
    const owner = await signIn(browser, "OWNER");
    ownerContext = owner.context;
    const member = await signIn(browser, "MEMBER");
    memberContext = member.context;
    await openCanvas(owner.page);
    await openCanvas(member.page);
    await expect(owner.page.locator('.ppm-canvas-presence[data-status="online"]')).toContainText("2");
    await expect(member.page.locator('.ppm-canvas-presence[data-status="online"]')).toContainText("2");

    const initial = await getCanvas(owner.page);
    expect(initial.access).toBe("edit");
    expect((await getCanvas(member.page)).access).toBe("edit");

    const noteTitle = `AF1.2 two-role smoke ${runId}`;
    await owner.page.getByRole("button", { name: /Добавить заметку ⇧N|Add note ⇧N/ }).click();
    await owner.page
      .getByRole("textbox", { name: /Новая заметка|New note/ })
      .last()
      .fill(noteTitle);
    await expect.poll(async () => (await getCanvas(owner.page)).version).toBeGreaterThan(initial.version);
    await expect(member.page.getByRole("textbox", { name: /Новая заметка|New note/ }).last()).toHaveValue(noteTitle);

    const ownerVersion = (await getCanvas(owner.page)).version;
    const memberSavedTitle = `AF1.2 member saved ${runId}`;
    await member.page
      .getByRole("textbox", { name: /Новая заметка|New note/ })
      .last()
      .fill(memberSavedTitle);
    await expect.poll(async () => (await getCanvas(member.page)).version).toBeGreaterThan(ownerVersion);
    await expect(owner.page.getByRole("textbox", { name: /Новая заметка|New note/ }).last()).toHaveValue(
      memberSavedTitle
    );

    const baseVersion = (await getCanvas(owner.page)).version;
    const memberTitle = `AF1.2 stale member ${runId}`;
    const ownerTitle = `AF1.2 canonical owner ${runId}`;
    let releaseMemberSave: (() => void) | undefined;
    let memberSaveSeen = false;
    const memberSaveGate = new Promise<void>((resolve) => {
      releaseMemberSave = resolve;
    });
    await member.page.route("**/api/ppm/v1/**", async (route) => {
      if (route.request().method() === "PUT" && route.request().url().includes("/canvas/")) {
        memberSaveSeen = true;
        await memberSaveGate;
      }
      await route.continue();
    });
    try {
      await member.page
        .getByRole("textbox", { name: /Новая заметка|New note/ })
        .last()
        .fill(memberTitle);
      await expect.poll(() => memberSaveSeen).toBe(true);
      await owner.page
        .getByRole("textbox", { name: /Новая заметка|New note/ })
        .last()
        .fill(ownerTitle);
      await expect.poll(async () => (await getCanvas(owner.page)).version).toBeGreaterThan(baseVersion);
    } finally {
      releaseMemberSave?.();
    }

    await expect(member.page.locator('.ppm-canvas-status__notice[data-status="conflict"]')).toBeVisible();
    const canonical = await getCanvas(owner.page);
    expect(JSON.stringify(canonical.snapshot?.document.store)).toContain(ownerTitle);
    expect(JSON.stringify(canonical.snapshot?.document.store)).not.toContain(memberTitle);
  } finally {
    await closeContext(memberContext);
    await closeContext(ownerContext);
  }
});

test("offline note is saved after reconnect without another edit", async ({ browser }) => {
  test.setTimeout(60_000);
  let ownerContext: BrowserContext | undefined;
  let memberContext: BrowserContext | undefined;
  try {
    const owner = await signIn(browser, "OWNER");
    ownerContext = owner.context;
    const member = await signIn(browser, "MEMBER");
    memberContext = member.context;
    await openCanvas(owner.page);
    await openCanvas(member.page);
    await expect(owner.page.locator('.ppm-canvas-presence[data-status="online"]')).toBeVisible();
    const initialVersion = (await getCanvas(member.page)).version;
    const noteTitle = `AF1.2 offline retry ${runId}`;

    await expect(owner.page.locator(".ppm-canvas-shell")).toHaveAttribute("data-ppm-canvas-mode", "edit");
    await owner.context.setOffline(true);
    await expect(owner.page.locator('.ppm-canvas-presence[data-status="offline"]')).toBeVisible();
    await owner.page.getByRole("button", { name: /Добавить заметку ⇧N|Add note ⇧N/ }).click();
    await owner.page
      .getByRole("textbox", { name: /Новая заметка|New note/ })
      .last()
      .fill(noteTitle);
    await expect(owner.page.locator('.ppm-canvas-status__notice[data-status="error"]')).toBeVisible();
    expect((await getCanvas(member.page)).version).toBe(initialVersion);
    expect(
      await owner.page.evaluate(
        (title) =>
          Object.keys(sessionStorage).some(
            (key) => key.startsWith("ppm:canvas:recovery:v1:") && sessionStorage.getItem(key)?.includes(title)
          ),
        noteTitle
      )
    ).toBe(true);

    await owner.context.setOffline(false);
    await expect(owner.page.locator('.ppm-canvas-presence[data-status="online"]')).toBeVisible();
    await expect
      .poll(async () => (await getCanvas(member.page)).version, { timeout: 25_000 })
      .toBeGreaterThan(initialVersion);
    await expect(member.page.getByRole("textbox", { name: /Новая заметка|New note/ }).last()).toHaveValue(noteTitle);
  } finally {
    if (ownerContext) await ownerContext.setOffline(false);
    await closeContext(memberContext);
    await closeContext(ownerContext);
  }
});

test("failed HTTP saves retry in the background while presence remains online", async ({ browser }) => {
  test.setTimeout(45_000);
  let ownerContext: BrowserContext | undefined;
  try {
    const owner = await signIn(browser, "OWNER");
    ownerContext = owner.context;
    await openCanvas(owner.page);
    await expect(owner.page.locator('.ppm-canvas-presence[data-status="online"]')).toBeVisible();
    const initialVersion = (await getCanvas(owner.page)).version;
    const noteTitle = `AF1.2 background retry ${runId}`;
    const operationIds: string[] = [];
    await owner.page.route("**/canvas/boards/*/snapshot/", async (route) => {
      operationIds.push((route.request().postDataJSON() as { client_operation_id: string }).client_operation_id);
      if (operationIds.length < 3) await route.abort("failed");
      else await route.continue();
    });

    await owner.page.getByRole("button", { name: /Добавить заметку ⇧N|Add note ⇧N/ }).click();
    await owner.page
      .getByRole("textbox", { name: /Новая заметка|New note/ })
      .last()
      .fill(noteTitle);
    await expect(owner.page.locator('.ppm-canvas-status__notice[data-status="error"]')).toBeVisible();
    await expect(owner.page.locator('.ppm-canvas-presence[data-status="online"]')).toBeVisible();
    await expect
      .poll(async () => (await getCanvas(owner.page)).version, { timeout: 25_000 })
      .toBeGreaterThan(initialVersion);
    expect(operationIds).toHaveLength(3);
    expect(new Set(operationIds).size).toBe(1);
    expect(JSON.stringify((await getCanvas(owner.page)).snapshot?.document.store)).toContain(noteTitle);
  } finally {
    await closeContext(ownerContext);
  }
});

test("offline draft survives a closed browser context and requires explicit restore", async ({ browser }) => {
  let ownerContext: BrowserContext | undefined;
  let resumedContext: BrowserContext | undefined;
  try {
    const owner = await signIn(browser, "OWNER");
    ownerContext = owner.context;
    await openCanvas(owner.page);
    await expect(owner.page.locator(".ppm-canvas-shell")).toHaveAttribute("data-ppm-canvas-mode", "edit");
    const initialVersion = (await getCanvas(owner.page)).version;
    const noteTitle = `AF1.2 durable offline ${runId}`;

    await owner.context.setOffline(true);
    await expect(owner.page.locator('.ppm-canvas-presence[data-status="offline"]')).toBeVisible();
    await owner.page.getByRole("button", { name: /Добавить заметку ⇧N|Add note ⇧N/ }).click();
    await owner.page
      .getByRole("textbox", { name: /Новая заметка|New note/ })
      .last()
      .fill(noteTitle);
    await expect(owner.page.locator('.ppm-canvas-status__notice[data-status="error"]')).toBeVisible();
    await expect
      .poll(() =>
        owner.page.evaluate(
          (title) =>
            Object.keys(localStorage).some(
              (key) => key.startsWith("ppm:canvas:durable-recovery:v1:") && localStorage.getItem(key)?.includes(title)
            ),
          noteTitle
        )
      )
      .toBe(true);

    const pendingOperationId = await owner.page.evaluate((title) => {
      const raw = Object.keys(localStorage)
        .filter((key) => key.startsWith("ppm:canvas:durable-recovery:v1:"))
        .map((key) => localStorage.getItem(key))
        .find((value) => value?.includes(title));
      return raw
        ? (JSON.parse(raw) as { pending_operation?: { client_operation_id: string } }).pending_operation
            ?.client_operation_id
        : undefined;
    }, noteTitle);
    expect(pendingOperationId).toMatch(/^[\da-f-]{36}$/i);

    const persistedBrowserState = await owner.context.storageState();
    await owner.context.close();
    ownerContext = undefined;
    resumedContext = await browser.newContext({
      baseURL,
      locale: "ru-RU",
      viewport: { width: 1440, height: 900 },
      storageState: persistedBrowserState,
    });
    const resumedPage = await resumedContext.newPage();
    await openCanvas(resumedPage);
    await expect(resumedPage.getByRole("button", { name: "Восстановить черновик" })).toBeVisible();
    expect((await getCanvas(resumedPage)).version).toBe(initialVersion);
    const replayRequest = resumedPage.waitForRequest(
      (request) =>
        request.method() === "PUT" && request.url().includes("/canvas/boards/") && request.url().endsWith("/snapshot/")
    );
    await resumedPage.getByRole("button", { name: "Восстановить черновик" }).click();
    expect((await replayRequest).postDataJSON().client_operation_id).toBe(pendingOperationId);
    await expect.poll(async () => (await getCanvas(resumedPage)).version).toBeGreaterThan(initialVersion);
    await expect(resumedPage.getByRole("textbox", { name: /Новая заметка|New note/ }).last()).toHaveValue(noteTitle);
    await expect
      .poll(() =>
        resumedPage.evaluate(
          (title) =>
            !Object.keys(localStorage).some(
              (key) => key.startsWith("ppm:canvas:durable-recovery:v1:") && localStorage.getItem(key)?.includes(title)
            ),
          noteTitle
        )
      )
      .toBe(true);
  } finally {
    await closeContext(resumedContext);
    await closeContext(ownerContext);
  }
});

test("lost save response replays the same operation before saving later local edits", async ({ browser }) => {
  let ownerContext: BrowserContext | undefined;
  let resumedContext: BrowserContext | undefined;
  try {
    const owner = await signIn(browser, "OWNER");
    ownerContext = owner.context;
    await openCanvas(owner.page);
    const initialVersion = (await getCanvas(owner.page)).version;
    const firstTitle = `AF1.2 lost ack first ${runId}`;
    const laterTitle = `AF1.2 lost ack later ${runId}`;
    let savedWithoutAck = false;
    await owner.page.route("**/canvas/boards/*/snapshot/", async (route) => {
      if (!savedWithoutAck) {
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        savedWithoutAck = true;
      }
      await route.abort("failed");
    });
    await owner.page.getByRole("button", { name: /Добавить заметку ⇧N|Add note ⇧N/ }).click();
    const note = owner.page.getByRole("textbox", { name: /Новая заметка|New note/ }).last();
    await note.fill(firstTitle);
    await expect(owner.page.locator('.ppm-canvas-status__notice[data-status="error"]')).toBeVisible();
    await expect.poll(async () => (await getCanvas(owner.page)).version).toBe(initialVersion + 1);
    await note.fill(laterTitle);
    await expect
      .poll(() =>
        owner.page.evaluate(
          (title) =>
            Object.keys(localStorage).some(
              (key) => key.startsWith("ppm:canvas:durable-recovery:v1:") && localStorage.getItem(key)?.includes(title)
            ),
          laterTitle
        )
      )
      .toBe(true);
    const persistedBrowserState = await owner.context.storageState();
    await owner.context.close();
    ownerContext = undefined;
    resumedContext = await browser.newContext({
      baseURL,
      locale: "ru-RU",
      viewport: { width: 1440, height: 900 },
      storageState: persistedBrowserState,
    });
    const resumedPage = await resumedContext.newPage();
    await openCanvas(resumedPage);
    await expect(resumedPage.getByRole("button", { name: "Проверить сохранение" })).toBeVisible();
    expect((await getCanvas(resumedPage)).version).toBe(initialVersion + 1);
    await resumedPage.getByRole("button", { name: "Проверить сохранение" }).click();
    await expect.poll(async () => (await getCanvas(resumedPage)).version).toBe(initialVersion + 2);
    await expect(resumedPage.getByRole("textbox", { name: /Новая заметка|New note/ }).last()).toHaveValue(laterTitle);
  } finally {
    await closeContext(resumedContext);
    await closeContext(ownerContext);
  }
});

test("offline draft survives a full browser process restart with a persistent profile", async ({
  browser,
}, testInfo) => {
  const email = process.env.PPM_E2E_OWNER_EMAIL;
  const password = process.env.PPM_E2E_OWNER_PASSWORD;
  if (!email || !password) throw new Error("Missing local OWNER test credentials.");
  const browserType = browser.browserType();
  const profileDirectory = testInfo.outputPath("ppm-canvas-persistent-profile");
  const launchOptions = {
    baseURL,
    locale: "ru-RU",
    viewport: { width: 1440, height: 900 },
    ...(process.env.PPM_E2E_BROWSER_CHANNEL ? { channel: process.env.PPM_E2E_BROWSER_CHANNEL } : {}),
  };
  let persistentContext: BrowserContext | undefined;
  try {
    persistentContext = await browserType.launchPersistentContext(profileDirectory, launchOptions);
    let page = persistentContext.pages()[0] ?? (await persistentContext.newPage());
    await page.goto("/sign-in");
    await page.locator("#email").fill(email, { timeout: 90_000 });
    await page.getByRole("button", { name: "Продолжить", exact: true }).click();
    await page.locator("#password").fill(password);
    await page.getByRole("button", { name: /Продолжить|Открыть пространство/ }).click();
    await expect.poll(() => hasApiSession(page)).toBe(true);
    await openCanvas(page);
    const initialVersion = (await getCanvas(page)).version;
    const noteTitle = `AF1.2 persistent browser ${runId}`;

    await expect(page.locator(".ppm-canvas-shell")).toHaveAttribute("data-ppm-canvas-mode", "edit");
    await persistentContext.setOffline(true);
    await expect(page.locator('.ppm-canvas-presence[data-status="offline"]')).toBeVisible();
    await page.getByRole("button", { name: /Добавить заметку ⇧N|Add note ⇧N/ }).click();
    await page
      .getByRole("textbox", { name: /Новая заметка|New note/ })
      .last()
      .fill(noteTitle);
    await expect
      .poll(() =>
        page.evaluate(
          (title) =>
            Object.keys(localStorage).some(
              (key) => key.startsWith("ppm:canvas:durable-recovery:v1:") && localStorage.getItem(key)?.includes(title)
            ),
          noteTitle
        )
      )
      .toBe(true);
    await persistentContext.close();
    persistentContext = undefined;

    persistentContext = await browserType.launchPersistentContext(profileDirectory, launchOptions);
    page = persistentContext.pages()[0] ?? (await persistentContext.newPage());
    await openCanvas(page);
    await expect(page.getByRole("button", { name: "Восстановить черновик" })).toBeVisible();
    expect((await getCanvas(page)).version).toBe(initialVersion);
    await page.getByRole("button", { name: "Восстановить черновик" }).click();
    await expect.poll(async () => (await getCanvas(page)).version).toBeGreaterThan(initialVersion);
    await expect(page.getByRole("textbox", { name: /Новая заметка|New note/ }).last()).toHaveValue(noteTitle);
  } finally {
    await closeContext(persistentContext);
    // The profile contains a synthetic authenticated session; do not leave it in test-results.
    await rm(profileDirectory, { force: true, recursive: true });
  }
});

test("offline draft after context recreation cannot replace a newer team version", async ({ browser }) => {
  let ownerContext: BrowserContext | undefined;
  let memberContext: BrowserContext | undefined;
  let resumedContext: BrowserContext | undefined;
  try {
    const owner = await signIn(browser, "OWNER");
    ownerContext = owner.context;
    const member = await signIn(browser, "MEMBER");
    memberContext = member.context;
    await openCanvas(owner.page);
    await openCanvas(member.page);
    const offlineTitle = `AF1.2 durable conflict ${runId}`;
    const teamTitle = `AF1.2 durable teammate ${runId}`;

    await expect(owner.page.locator(".ppm-canvas-shell")).toHaveAttribute("data-ppm-canvas-mode", "edit");
    await owner.context.setOffline(true);
    await expect(owner.page.locator('.ppm-canvas-presence[data-status="offline"]')).toBeVisible();
    await owner.page.getByRole("button", { name: /Добавить заметку ⇧N|Add note ⇧N/ }).click();
    await owner.page
      .getByRole("textbox", { name: /Новая заметка|New note/ })
      .last()
      .fill(offlineTitle);
    await expect(owner.page.locator('.ppm-canvas-status__notice[data-status="error"]')).toBeVisible();
    await expect
      .poll(() =>
        owner.page.evaluate(
          (title) =>
            Object.keys(localStorage).some(
              (key) => key.startsWith("ppm:canvas:durable-recovery:v1:") && localStorage.getItem(key)?.includes(title)
            ),
          offlineTitle
        )
      )
      .toBe(true);
    const persistedBrowserState = await owner.context.storageState();
    await owner.context.close();
    ownerContext = undefined;

    const initialVersion = (await getCanvas(member.page)).version;
    await member.page.getByRole("button", { name: /Добавить заметку ⇧N|Add note ⇧N/ }).click();
    await member.page
      .getByRole("textbox", { name: /Новая заметка|New note/ })
      .last()
      .fill(teamTitle);
    await expect.poll(async () => (await getCanvas(member.page)).version).toBeGreaterThan(initialVersion);

    resumedContext = await browser.newContext({
      baseURL,
      locale: "ru-RU",
      viewport: { width: 1440, height: 900 },
      storageState: persistedBrowserState,
    });
    const resumedPage = await resumedContext.newPage();
    await openCanvas(resumedPage);
    await expect(resumedPage.getByRole("button", { name: "Скачать черновик" })).toBeVisible();
    await expect(resumedPage.getByRole("button", { name: "Восстановить черновик" })).toHaveCount(0);
    const rejectedReplay = resumedPage.waitForResponse(
      (response) =>
        response.request().method() === "PUT" && response.url().endsWith("/snapshot/") && response.status() === 409
    );
    await resumedPage.getByRole("button", { name: "Проверить сохранение" }).click();
    await rejectedReplay;
    const canonical = await getCanvas(resumedPage);
    expect(JSON.stringify(canonical.snapshot?.document.store)).toContain(teamTitle);
    expect(JSON.stringify(canonical.snapshot?.document.store)).not.toContain(offlineTitle);
  } finally {
    await closeContext(resumedContext);
    await closeContext(memberContext);
    await closeContext(ownerContext);
  }
});

test("two offline tabs keep separate drafts and recovering one preserves the other", async ({ browser }) => {
  // Two live editors and a recreated context cost more under a full serial browser gate.
  test.setTimeout(60_000);
  let ownerContext: BrowserContext | undefined;
  let resumedContext: BrowserContext | undefined;
  try {
    const owner = await signIn(browser, "OWNER");
    ownerContext = owner.context;
    await openCanvas(owner.page);
    const secondPage = await owner.context.newPage();
    await openCanvas(secondPage);
    const initialVersion = (await getCanvas(owner.page)).version;
    const firstTitle = `AF1.2 first offline tab ${runId}`;
    const secondTitle = `AF1.2 second offline tab ${runId}`;

    await expect(owner.page.locator(".ppm-canvas-shell")).toHaveAttribute("data-ppm-canvas-mode", "edit");
    await expect(secondPage.locator(".ppm-canvas-shell")).toHaveAttribute("data-ppm-canvas-mode", "edit");
    await owner.context.setOffline(true);
    await expect(owner.page.locator('.ppm-canvas-presence[data-status="offline"]')).toBeVisible();
    await expect(secondPage.locator('.ppm-canvas-presence[data-status="offline"]')).toBeVisible();
    await owner.page.getByRole("button", { name: /Добавить заметку ⇧N|Add note ⇧N/ }).click();
    await owner.page
      .getByRole("textbox", { name: /Новая заметка|New note/ })
      .last()
      .fill(firstTitle);
    await secondPage.getByRole("button", { name: /Добавить заметку ⇧N|Add note ⇧N/ }).click();
    await secondPage
      .getByRole("textbox", { name: /Новая заметка|New note/ })
      .last()
      .fill(secondTitle);
    await expect
      .poll(() =>
        owner.page.evaluate(
          ([first, second]) => {
            const drafts = Object.keys(localStorage)
              .filter((key) => key.startsWith("ppm:canvas:durable-recovery:v1:"))
              .map((key) => localStorage.getItem(key));
            return drafts.some((item) => item?.includes(first)) && drafts.some((item) => item?.includes(second));
          },
          [firstTitle, secondTitle]
        )
      )
      .toBe(true);

    const persistedBrowserState = await owner.context.storageState();
    await owner.context.close();
    ownerContext = undefined;
    resumedContext = await browser.newContext({
      baseURL,
      locale: "ru-RU",
      viewport: { width: 1440, height: 900 },
      storageState: persistedBrowserState,
    });
    const resumedPage = await resumedContext.newPage();
    await openCanvas(resumedPage);
    const selector = resumedPage.getByRole("combobox", { name: "Выберите локальный черновик" });
    await expect(selector.locator("option")).toHaveCount(2);
    const firstKey = await resumedPage.evaluate(
      (title) =>
        Object.keys(localStorage).find(
          (key) => key.startsWith("ppm:canvas:durable-recovery:v1:") && localStorage.getItem(key)?.includes(title)
        ),
      firstTitle
    );
    if (!firstKey) throw new Error("The first tab's durable draft is missing.");
    await selector.selectOption(firstKey);
    await resumedPage.getByRole("button", { name: "Восстановить черновик" }).click();
    await expect.poll(async () => (await getCanvas(resumedPage)).version).toBeGreaterThan(initialVersion);
    const canonical = await getCanvas(resumedPage);
    expect(JSON.stringify(canonical.snapshot?.document.store)).toContain(firstTitle);
    expect(JSON.stringify(canonical.snapshot?.document.store)).not.toContain(secondTitle);
    expect(
      await resumedPage.evaluate(
        (title) =>
          Object.keys(localStorage).some(
            (key) => key.startsWith("ppm:canvas:durable-recovery:v1:") && localStorage.getItem(key)?.includes(title)
          ),
        secondTitle
      )
    ).toBe(true);
    await resumedPage.reload();
    await expect(resumedPage.getByRole("button", { name: "Скачать черновик" })).toBeVisible();
    await expect(resumedPage.getByRole("button", { name: "Восстановить черновик" })).toHaveCount(0);
  } finally {
    await closeContext(resumedContext);
    await closeContext(ownerContext);
  }
});

test("offline draft conflicts with a newer team save without overwriting it", async ({ browser }) => {
  let ownerContext: BrowserContext | undefined;
  let memberContext: BrowserContext | undefined;
  try {
    const owner = await signIn(browser, "OWNER");
    ownerContext = owner.context;
    const member = await signIn(browser, "MEMBER");
    memberContext = member.context;
    await openCanvas(owner.page);
    await openCanvas(member.page);
    const initialVersion = (await getCanvas(member.page)).version;
    const offlineTitle = `AF1.2 offline local ${runId}`;
    const teamTitle = `AF1.2 online teammate ${runId}`;

    await expect(owner.page.locator(".ppm-canvas-shell")).toHaveAttribute("data-ppm-canvas-mode", "edit");
    await owner.context.setOffline(true);
    await expect(owner.page.locator('.ppm-canvas-presence[data-status="offline"]')).toBeVisible();
    await owner.page.getByRole("button", { name: /Добавить заметку ⇧N|Add note ⇧N/ }).click();
    await owner.page
      .getByRole("textbox", { name: /Новая заметка|New note/ })
      .last()
      .fill(offlineTitle);
    await expect(owner.page.locator('.ppm-canvas-status__notice[data-status="error"]')).toBeVisible();

    await member.page.getByRole("button", { name: /Добавить заметку ⇧N|Add note ⇧N/ }).click();
    await member.page
      .getByRole("textbox", { name: /Новая заметка|New note/ })
      .last()
      .fill(teamTitle);
    await expect.poll(async () => (await getCanvas(member.page)).version).toBeGreaterThan(initialVersion);

    await owner.context.setOffline(false);
    await expect(owner.page.locator('.ppm-canvas-status__notice[data-status="conflict"]')).toBeVisible();
    const canonical = await getCanvas(member.page);
    expect(JSON.stringify(canonical.snapshot?.document.store)).toContain(teamTitle);
    expect(JSON.stringify(canonical.snapshot?.document.store)).not.toContain(offlineTitle);
    expect(
      await owner.page.evaluate(
        (title) =>
          Object.keys(localStorage).some(
            (key) => key.startsWith("ppm:canvas:durable-recovery:v1:") && localStorage.getItem(key)?.includes(title)
          ),
        offlineTitle
      )
    ).toBe(true);
  } finally {
    if (ownerContext) await ownerContext.setOffline(false);
    await closeContext(memberContext);
    await closeContext(ownerContext);
  }
});

test("project guest can read the board but cannot edit it", async ({ browser }) => {
  let guestContext: BrowserContext | undefined;
  try {
    const guest = await signIn(browser, "GUEST");
    guestContext = guest.context;
    await openCanvas(guest.page);
    expect((await getCanvas(guest.page)).access).toBe("read");
    await expect(guest.page.locator(".ppm-canvas-shell")).toHaveAttribute("data-ppm-canvas-mode", "read");
    await expect(guest.page.getByRole("button", { name: /Добавить заметку ⇧N|Add note ⇧N/ })).toHaveCount(0);
    const initial = await getCanvas(guest.page);
    await guest.page.keyboard.press("Shift+N");
    await expect(guest.page.locator(".ppm-canvas-shell")).toHaveAttribute("data-ppm-canvas-mode", "read");
    expect((await getCanvas(guest.page)).version).toBe(initial.version);
  } finally {
    await closeContext(guestContext);
  }
});

test("member of one project cannot open another project's board", async ({ browser }) => {
  const otherProjectId = process.env.PPM_E2E_OTHER_PROJECT_ID;
  const otherBoardId = process.env.PPM_E2E_OTHER_BOARD_ID;
  test.skip(!otherProjectId || !otherBoardId, "Requires a second isolated project without member access.");
  if (!workspaceSlug || !workspaceId || !otherProjectId || !otherBoardId)
    throw new Error("Missing isolated cross-project test IDs.");
  let memberContext: BrowserContext | undefined;
  try {
    const member = await signIn(browser, "MEMBER");
    memberContext = member.context;
    const denied = await member.page.request.get(
      new URL(`/api/ppm/v1/workspaces/${workspaceId}/projects/${otherProjectId}/canvas/`, apiBaseURL).href
    );
    expect(denied.status()).toBe(403);

    const wsBase = new URL(apiBaseURL);
    wsBase.protocol = wsBase.protocol === "https:" ? "wss:" : "ws:";
    wsBase.pathname = `/ws/ppm/v1/workspaces/${workspaceId}/projects/${otherProjectId}/canvas/boards/${otherBoardId}/presence/`;
    const socketOutcome = await member.page.evaluate(
      (url) =>
        new Promise<{ opened: boolean; receivedReady: boolean }>((resolve) => {
          const socket = new WebSocket(url);
          let opened = false;
          let receivedReady = false;
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            resolve({ opened, receivedReady });
          };
          const timer = window.setTimeout(() => {
            socket.close();
            finish();
          }, 5_000);
          socket.addEventListener("open", () => {
            opened = true;
          });
          socket.addEventListener("message", (event) => {
            if (typeof event.data === "string" && event.data.includes('"type":"presence.ready"')) receivedReady = true;
          });
          socket.addEventListener("close", () => {
            clearTimeout(timer);
            finish();
          });
        }),
      wsBase.href
    );
    expect(socketOutcome).toEqual({ opened: false, receivedReady: false });

    await member.page.goto(`/${workspaceSlug}/projects/${otherProjectId}/brain/`);
    await expect(member.page.getByRole("application", { name: "tldraw" })).toHaveCount(0);
  } finally {
    await closeContext(memberContext);
  }
});

test("global administrator can enter an unrelated board and leaves a WebSocket audit event", async ({ browser }) => {
  test.setTimeout(60_000);
  const otherProjectId = process.env.PPM_E2E_OTHER_PROJECT_ID;
  const otherBoardId = process.env.PPM_E2E_OTHER_BOARD_ID;
  test.skip(
    !otherProjectId || !otherBoardId || !process.env.PPM_E2E_GLOBAL_EMAIL,
    "Requires a disposable global admin."
  );
  if (!workspaceSlug || !workspaceId || !otherProjectId || !otherBoardId)
    throw new Error("Missing isolated global admin test IDs.");
  let globalContext: BrowserContext | undefined;
  try {
    const global = await signIn(browser, "GLOBAL");
    globalContext = global.context;
    await global.page.goto("/ppm-admin");
    const projectRow = global.page.locator("article").filter({ hasText: "AF1.2 isolation fixture" });
    await expect(projectRow).toBeVisible();
    await projectRow.getByRole("button", { name: "Открыть в режиме администратора" }).click();
    await expect(global.page).toHaveURL(
      new URL(`/${workspaceSlug}/projects/${otherProjectId}/overview/?ppm_admin_mode=1`, baseURL).href
    );
    await global.page
      .getByRole("navigation", { name: "Навигация проекта" })
      .first()
      .getByRole("link", { name: "Холст" })
      .click();
    await expect(global.page).toHaveURL(
      new URL(`/${workspaceSlug}/projects/${otherProjectId}/brain/?ppm_admin_mode=1`, baseURL).href
    );
    await expect(
      global.page.getByText("Режим главного администратора: проект открыт вне обычного членства.")
    ).toBeVisible();
    await expect(global.page.getByRole("main", { name: /Холст проекта|Project canvas/ })).toBeVisible();
    await expect(global.page.getByRole("application", { name: "tldraw" })).toBeVisible();

    const canvas = await global.page.request.get(
      new URL(`/api/ppm/v1/workspaces/${workspaceId}/projects/${otherProjectId}/canvas/`, apiBaseURL).href
    );
    expect(canvas.status()).toBe(200);
    expect((await canvas.json()).access).toBe("edit");

    const wsUrl = new URL(apiBaseURL);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.pathname = `/ws/ppm/v1/workspaces/${workspaceId}/projects/${otherProjectId}/canvas/boards/${otherBoardId}/presence/`;
    const ready = await global.page.evaluate(
      (url) =>
        new Promise<{ access: string | null; boardVersion: number | null }>((resolve, reject) => {
          const socket = new WebSocket(url);
          const timer = window.setTimeout(() => {
            socket.close();
            reject(new Error("Global administrator presence did not become ready."));
          }, 10_000);
          socket.addEventListener("message", (event) => {
            if (typeof event.data !== "string") return;
            const message = JSON.parse(event.data);
            if (message.type !== "presence.ready") return;
            clearTimeout(timer);
            socket.close();
            resolve({ access: message.self?.access ?? null, boardVersion: message.board_version ?? null });
          });
          socket.addEventListener("close", () => {
            clearTimeout(timer);
            reject(new Error("Global administrator presence closed before becoming ready."));
          });
        }),
      wsUrl.href
    );
    expect(ready.access).toBe("edit");
    expect(ready.boardVersion).toEqual(expect.any(Number));

    const auditUrl = new URL("/api/ppm/v1/admin/audit/?page_size=50", apiBaseURL).href;
    await expect
      .poll(async () => {
        const response = await global.page.request.get(auditUrl);
        expect(response.status()).toBe(200);
        const audit = await response.json();
        return audit.results.some(
          (event: { action: string; project_id: string; method: string; metadata: { board_id?: string } }) =>
            event.action === "canvas_presence_connect" &&
            event.project_id === otherProjectId &&
            event.method === "WS" &&
            event.metadata.board_id === otherBoardId
        );
      })
      .toBe(true);
  } finally {
    await closeContext(globalContext);
  }
});

test("revoked guest immediately loses the open board", async ({ browser }) => {
  // Login, membership mutation, revocation heartbeat and restoration run in one test.
  test.setTimeout(60_000);
  test.skip(process.env.PPM_E2E_REVOKE_GUEST !== "1", "Requires a disposable guest membership for revocation.");
  const membershipId = process.env.PPM_E2E_GUEST_MEMBERSHIP_ID;
  if (!workspaceSlug || !workspaceId || !projectId || !membershipId)
    throw new Error("Missing isolated guest membership IDs.");
  let ownerContext: BrowserContext | undefined;
  let guestContext: BrowserContext | undefined;
  try {
    const owner = await signIn(browser, "OWNER");
    ownerContext = owner.context;
    const guest = await signIn(browser, "GUEST");
    guestContext = guest.context;
    await openCanvas(guest.page);
    await expect(guest.page.locator('.ppm-canvas-presence[data-status="online"]')).toBeVisible();
    expect((await getCanvas(guest.page)).access).toBe("read");
    const guestProfileResponse = await guest.page.request.get(currentUserURL);
    expect(guestProfileResponse.status()).toBe(200);
    const guestProfile: unknown = await guestProfileResponse.json();
    if (typeof guestProfile !== "object" || guestProfile === null || !("id" in guestProfile))
      throw new Error("Synthetic guest profile is missing its user ID.");
    const guestUserId = guestProfile.id;
    if (typeof guestUserId !== "string") throw new Error("Synthetic guest user ID is invalid.");

    const membershipURL = new URL(
      `/api/workspaces/${workspaceSlug}/projects/${projectId}/members/${membershipId}/`,
      apiBaseURL
    ).href;
    try {
      const response = await owner.page.request.patch(membershipURL, { data: { is_active: false } });
      expect(response.status()).toBe(200);
      await expect(
        guest.page.getByText(/Вы не состоите в этом проекте|You are not a member of this project/)
      ).toBeVisible({ timeout: 30_000 });
      await expect(guest.page.locator(".ppm-canvas-shell")).toHaveCount(0);
      const denied = await guest.page.request.get(
        new URL(`/api/ppm/v1/workspaces/${workspaceId}/projects/${projectId}/canvas/`, apiBaseURL).href
      );
      expect(denied.status()).toBe(403);
    } finally {
      const restored = await owner.page.request.post(
        new URL(`/api/workspaces/${workspaceSlug}/projects/${projectId}/members/`, apiBaseURL).href,
        { data: { members: [{ member_id: guestUserId, role: 5 }] } }
      );
      expect(restored.status()).toBe(201);
    }
    await openCanvas(guest.page);
    expect((await getCanvas(guest.page)).access).toBe("read");
  } finally {
    await closeContext(guestContext);
    await closeContext(ownerContext);
  }
});

test("editor role downgrade requires a fresh read-only board session", async ({ browser }) => {
  const membershipId = process.env.PPM_E2E_MEMBER_MEMBERSHIP_ID;
  test.skip(!membershipId, "Requires a disposable project membership ID.");
  if (!workspaceSlug || !projectId || !membershipId) throw new Error("Missing isolated member membership IDs.");
  let ownerContext: BrowserContext | undefined;
  let memberContext: BrowserContext | undefined;
  try {
    const owner = await signIn(browser, "OWNER");
    ownerContext = owner.context;
    const member = await signIn(browser, "MEMBER");
    memberContext = member.context;
    await openCanvas(member.page);
    await expect(member.page.locator('.ppm-canvas-presence[data-status="online"]')).toBeVisible();
    await expect(member.page.locator(".ppm-canvas-shell")).toHaveAttribute("data-ppm-canvas-mode", "edit");
    const membershipURL = new URL(
      `/api/workspaces/${workspaceSlug}/projects/${projectId}/members/${membershipId}/`,
      apiBaseURL
    ).href;
    try {
      const downgraded = await owner.page.request.patch(membershipURL, { data: { role: 5 } });
      expect(downgraded.status()).toBe(200);
      await expect(
        member.page.getByText(/Вы не состоите в этом проекте|You are not a member of this project/)
      ).toBeVisible({ timeout: 30_000 });
      await expect(member.page.locator(".ppm-canvas-shell")).toHaveCount(0);
      expect((await getCanvas(member.page)).access).toBe("read");
      await openCanvas(member.page);
      await expect(member.page.locator(".ppm-canvas-shell")).toHaveAttribute("data-ppm-canvas-mode", "read");
    } finally {
      const restored = await owner.page.request.patch(membershipURL, { data: { role: 15 } });
      expect(restored.status()).toBe(200);
    }
    await openCanvas(member.page);
    await expect(member.page.locator(".ppm-canvas-shell")).toHaveAttribute("data-ppm-canvas-mode", "edit");
  } finally {
    await closeContext(memberContext);
    await closeContext(ownerContext);
  }
});

test("board dialogs trap keyboard focus and open tabs support arrow navigation", async ({ browser }) => {
  const owner = await signIn(browser, "OWNER");
  try {
    await openCanvas(owner.page);
    const switcher = owner.page.locator(".ppm-canvas-board-switcher");
    await switcher.focus();
    await owner.page.keyboard.press("Enter");
    const boardDialog = owner.page.getByRole("dialog", { name: /Доски|Boards/ });
    await expect(boardDialog).toBeVisible();
    const closeBoardDialog = boardDialog.getByRole("button", { name: /Закрыть|Close/, exact: true });
    const createBoard = boardDialog.getByRole("button", { name: /Новая доска|New board/ });
    await createBoard.focus();
    await owner.page.keyboard.press("Tab");
    await expect(closeBoardDialog).toBeFocused();
    await owner.page.keyboard.press("Shift+Tab");
    await expect(createBoard).toBeFocused();
    await owner.page.keyboard.press("Escape");
    await expect(boardDialog).toHaveCount(0);
    await expect(switcher).toBeFocused();

    const commandTrigger = owner.page.locator(".ppm-canvas-command-trigger");
    await commandTrigger.click();
    const commandDialog = owner.page.getByRole("dialog", { name: /Палитра команд холста|Canvas command palette/ });
    await expect(commandDialog).toBeVisible();
    const commandSearch = commandDialog.getByRole("textbox", { name: /Найти команду холста|Find a Canvas command/ });
    await expect(commandSearch).toBeFocused();
    await commandDialog.locator("button").last().focus();
    await owner.page.keyboard.press("Tab");
    await expect(commandSearch).toBeFocused();
    await owner.page.keyboard.press("Escape");
    await expect(commandDialog).toHaveCount(0);
    await expect(commandTrigger).toBeFocused();

    await owner.page.locator(".ppm-canvas-tabs__new").click();
    const nameDialog = owner.page.getByRole("dialog", { name: /Новая доска|New board/ });
    await expect(nameDialog).toBeVisible();
    await nameDialog.getByRole("textbox", { name: /Название доски|Board name/ }).fill(`AF1.2 keyboard ${runId}`);
    await nameDialog.getByRole("button", { name: /Новая доска|New board/ }).click();
    await expect(nameDialog).toHaveCount(0);

    const tabs = owner.page.getByRole("tablist", { name: /Открытые доски холста|Open Canvas boards/ });
    await expect(tabs.getByRole("tab")).toHaveCount(2);
    const first = tabs.getByRole("tab").first();
    const second = tabs.getByRole("tab").last();
    await first.focus();
    await owner.page.keyboard.press("ArrowRight");
    await expect(second).toHaveAttribute("aria-selected", "true");
    await expect(second).toBeFocused();
    await owner.page.keyboard.press("Home");
    await expect(first).toHaveAttribute("aria-selected", "true");
    await expect(first).toBeFocused();
    await second.click();
    await owner.page.reload();
    await expect(tabs.getByRole("tab")).toHaveCount(2);
    await expect(tabs.getByRole("tab", { name: `AF1.2 keyboard ${runId}` })).toHaveAttribute("aria-selected", "true");
    await owner.page
      .locator(".ppm-canvas-tab")
      .last()
      .getByRole("button", { name: /Закрыть вкладку доски|Close board tab/ })
      .click();
    await expect(tabs.getByRole("tab").first()).toBeFocused();
  } finally {
    await owner.context.close();
  }
});

test("narrow Canvas keeps board navigation and named actions within its header", async ({ browser }) => {
  const owner = await signIn(browser, "OWNER");
  try {
    await owner.page.setViewportSize({ width: 320, height: 640 });
    if (!workspaceSlug || !projectId) throw new Error("Missing isolated AF1.2 project configuration.");
    await owner.page.goto(`/${workspaceSlug}/projects/${projectId}/brain/`);
    await expect(owner.page.getByRole("main", { name: /Холст проекта|Project canvas/ })).toBeVisible();
    await expect(owner.page.locator("#main-sidebar")).toHaveClass(/\bw-0\b/);
    await expect(owner.page.getByRole("application", { name: "tldraw" })).toBeVisible();
    await expect(owner.page.locator(".ppm-canvas-workspace")).not.toHaveAttribute("data-rail-expanded");
    await expect(owner.page.getByRole("tablist", { name: /Открытые доски холста|Open Canvas boards/ })).toBeHidden();

    const switcher = owner.page.locator(".ppm-canvas-board-switcher");
    const command = owner.page.getByRole("button", { name: /Найти команду холста|Find a Canvas command/ });
    const brain = owner.page.getByRole("button", {
      name: /Найти в проекте|Search project|Спросить проект|Ask project/,
    });
    const header = owner.page.locator(".ppm-canvas-workspace__header");
    const headerBox = await header.boundingBox();
    if (!headerBox) throw new Error("Canvas header has no visible bounds");
    const controlBoxes = await Promise.all(
      [switcher, command, brain].map(async (control) => {
        await expect(control).toBeVisible();
        return control.boundingBox();
      })
    );
    for (const controlBox of controlBoxes) {
      if (!controlBox) throw new Error("Canvas header control has no visible bounds");
      expect(controlBox.x).toBeGreaterThanOrEqual(headerBox.x);
      expect(controlBox.x + controlBox.width).toBeLessThanOrEqual(headerBox.x + headerBox.width + 1);
    }

    await switcher.click();
    await expect(owner.page.getByRole("dialog", { name: /Доски|Boards/ })).toBeVisible();
    await owner.page.keyboard.press("Escape");
    await command.click();
    await expect(
      owner.page.getByRole("dialog", { name: /Палитра команд холста|Canvas command palette/ })
    ).toBeVisible();
  } finally {
    await owner.context.close();
  }
});

test("Canvas has no automated WCAG A/AA violations at desktop and narrow widths", async ({ browser }) => {
  test.setTimeout(180_000);
  const owner = await signIn(browser, "OWNER");
  try {
    await openCanvas(owner.page);
    const expectAccessibleCanvas = async (state: string) => {
      const { violations } = await new AxeBuilder({ page: owner.page })
        .include(".ppm-canvas-workspace")
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(
        violations.map(({ id, impact, nodes }) => ({
          id,
          impact,
          targets: nodes.map((node) => node.target),
        })),
        `Canvas WCAG A/AA violations in ${state}`
      ).toEqual([]);
    };
    const checkWidth = async (width: number) => {
      await owner.page.setViewportSize({ width, height: 900 });
      if (width === 320) {
        await expect(owner.page.locator("#main-sidebar")).toHaveClass(/\bw-0\b/);
        await expect(owner.page.locator(".ppm-canvas-workspace")).not.toHaveAttribute("data-rail-expanded");
      }
      await expectAccessibleCanvas(`${width}px default board`);
      await owner.page.locator(".ppm-canvas-board-switcher").click();
      await expect(owner.page.getByRole("dialog", { name: /Доски|Boards/ })).toBeVisible();
      await expectAccessibleCanvas(`${width}px board switcher`);
      await owner.page.keyboard.press("Escape");
      await owner.page.getByRole("button", { name: /Найти команду холста|Find a Canvas command/ }).click();
      await expect(
        owner.page.getByRole("dialog", { name: /Палитра команд холста|Canvas command palette/ })
      ).toBeVisible();
      await expectAccessibleCanvas(`${width}px command palette`);
      await owner.page.keyboard.press("Escape");
    };
    await checkWidth(1440);
    await checkWidth(320);
  } finally {
    await owner.context.close();
  }
});
