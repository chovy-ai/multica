import "./env";
import { expect, test, type Page } from "@playwright/test";

// The conversation GUI shares a document with the app. Run against a server for
// the harness that scripts/build-e2e-harness.mjs writes to apps/web/public.
const TRACKED = ["color", "backgroundColor", "fontFamily", "fontSize", "lineHeight", "paddingTop", "paddingLeft", "borderTopWidth", "borderTopColor", "borderRadius", "boxSizing", "margin"] as const;

function appStyles(page: Page) {
  return page.evaluate((tracked) => Object.fromEntries(["html", "body", "#toggle", "#theme", "#heading", "#paragraph", '[data-testid="app-aside"]'].map((selector) => {
    const style = getComputedStyle(document.querySelector(selector)!);
    return [selector, Object.fromEntries(tracked.map((name) => [name, style[name]]))];
  })), TRACKED);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/tutti-agent-gui/direct.html");
});

test("mounting the GUI changes no app style, and unmounting removes it", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const before = await appStyles(page);
  await page.locator("#toggle").click();
  await expect(page.getByText("Reply in main-conversation")).toBeVisible();
  expect(await appStyles(page)).toEqual(before);
  await page.screenshot({ path: ".tmp/agent-gui-direct/light.png" });
  await page.locator("#toggle").click();
  await expect(page.getByTestId("agent-gui-root")).toHaveCount(0);
  expect(await appStyles(page)).toEqual(before);
  expect(errors).toEqual([]);
});

test("instances keep their own state in one document and fill their host", async ({ page }) => {
  await page.locator("#toggle").click();
  const main = page.locator('[data-instance="main-conversation"] [data-testid="agent-gui-root"]');
  const side = page.locator('[data-instance="side-conversation"] [data-testid="agent-gui-root"]');
  await expect(main.getByText("Reply in main-conversation")).toBeVisible();
  await expect(side.getByText("Reply in side-conversation")).toBeVisible();
  await expect(main).toHaveAttribute("data-side-pane", "false");
  await expect(side).toHaveAttribute("data-side-pane", "true");
  await expect(main.getByText("Reply in side-conversation")).toHaveCount(0);
  const boxes = await Promise.all([main.boundingBox(), side.boundingBox()]);
  for (const box of boxes) expect(box!.height).toBeGreaterThan(800);
  expect(Math.abs(boxes[0]!.width - boxes[1]!.width)).toBeLessThan(2);
});

test("GUI colors follow the theme without restyling the app", async ({ page }) => {
  await page.locator("#toggle").click();
  const root = page.getByTestId("agent-gui-root").first();
  await expect(page.getByText("Reply in main-conversation")).toBeVisible();
  const color = () => root.evaluate((element) => getComputedStyle(element).getPropertyValue("--background").trim());
  const light = await color();
  const before = await appStyles(page);
  await page.locator("#theme").click();
  await expect(page.getByTestId("agent-gui-root").first()).toHaveAttribute("data-theme", "dark");
  await expect(page.getByText("Reply in main-conversation")).toBeVisible();
  expect(await page.getByTestId("agent-gui-root").first().evaluate((element) => getComputedStyle(element).getPropertyValue("--background").trim())).not.toBe(light);
  expect(await appStyles(page)).toEqual(before);
  await page.screenshot({ path: ".tmp/agent-gui-direct/dark.png" });
});

test("GUI overlays are styled, though they render outside its root", async ({ page }) => {
  await page.locator("#toggle").click();
  await expect(page.getByText("Reply in main-conversation")).toBeVisible();
  await page.locator('[data-instance="main-conversation"]').getByText("Default model").locator("visible=true").first().click();
  const portal = page.locator("[data-tutti-portal-root]");
  await expect(portal).toHaveClass(/multica-agent-gui/);
  const overlay = portal.locator("*").first();
  await expect(overlay).toBeVisible();
  const background = await portal.locator("[role=menu], [role=listbox], [role=dialog], [data-slot*=content], [data-slot*=surface]").first()
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
  await page.screenshot({ path: ".tmp/agent-gui-direct/overlay.png" });
});
