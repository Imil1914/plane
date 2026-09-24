import { expect, test } from "@playwright/test";

const baseURL = process.env.PPM_E2E_BASE_URL ?? "http://localhost:3000";
const syntheticEmail = process.env.PPM_E2E_OWNER_EMAIL ?? "af12-browser-owner@ppm.test";

if (process.env.PPM_E2E_BROWSER_CHANNEL) {
  test.use({ launchOptions: { channel: process.env.PPM_E2E_BROWSER_CHANNEL } });
}

test("password is not submitted when a fresh CSRF token is unavailable", async ({ browser }) => {
  const context = await browser.newContext({ baseURL, locale: "ru-RU" });
  const page = await context.newPage();
  let signInPosts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/auth/sign-in/") signInPosts += 1;
  });
  await page.route("**/auth/get-csrf-token/", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" })
  );
  try {
    await page.goto("/sign-in");
    await page.locator("#email").fill(syntheticEmail);
    await page.getByRole("button", { name: "Продолжить", exact: true }).click();
    await page.locator("#password").fill("synthetic-unsubmitted-password");
    await page.getByRole("button", { name: /Продолжить|Открыть пространство/ }).click();
    await expect(page.getByRole("alert")).toContainText(
      /Не удалось безопасно начать вход|Sign-in could not start securely/
    );
    expect(signInPosts).toBe(0);
    await expect(page.locator("#password")).toBeVisible();
  } finally {
    await context.close();
  }
});
