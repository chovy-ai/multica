import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

async function openChanges(page: Page, theme: string, width: number) {
  await page.setViewportSize({ width, height: 960 });
  await page.route("**/__resources/content?*", route => route.fulfill({ contentType: "text/markdown", body: "# README" }));
  await page.goto(`/__test/resources?theme=${theme}`);
  const returnToChat = page.getByRole("button", { name: "Return to main chat", exact: true });
  await expect(page.getByRole("tab", { name: "README.md", exact: true })).toBeVisible();
  if (await returnToChat.isVisible()) await returnToChat.click();
  await page.getByRole("button", { name: "View changes", exact: true }).click();
  await expect(page.getByTestId("conversation-change-preview")).toBeVisible();
}

async function resourceState(page: Page, state: "loading" | "empty" | "failed" | "unsupported" | "many" | "ready") {
  await page.evaluate(state => (window as unknown as { __resourceFixture: { resourceState(state: string): void } }).__resourceFixture.resourceState(state), state);
}

for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
  test(`file picker stays beside the narrow Diff panel: ${theme} ${width}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await openChanges(page, theme, width);
    const preview = page.getByTestId("conversation-change-preview");
    const choose = page.getByRole("button", { name: "Choose changed file", exact: true });
    const picker = page.getByRole("dialog", { name: "Choose changed file", exact: true });
    const trigger = (await choose.boundingBox())!;
    await choose.click();
    await expect(picker).toBeVisible();
    await expect(picker.getByRole("treeitem", { name: "redirect.ts", exact: true })).toHaveAttribute("aria-selected", "true");
    const panel = (await preview.boundingBox())!;
    const popup = (await picker.boundingBox())!;
    expect(panel.width).toBeLessThan(640);
    expect(popup.y).toBeGreaterThanOrEqual(trigger.y + trigger.height);
    expect(popup.x).toBeGreaterThanOrEqual(panel.x);
    expect(popup.x + popup.width).toBeLessThanOrEqual(width);
    expect(popup.height).toBeLessThan(500);
    const heading = (await picker.getByRole("heading", { name: "Choose changed file" }).boundingBox())!;
    expect(heading.x - popup.x).toBeGreaterThanOrEqual(12);
    expect(heading.y - popup.y).toBeGreaterThanOrEqual(8);
    await expect(page.locator('[data-slot="sheet-overlay"]')).toHaveCount(0);
    await mkdir(".tmp/chov124", { recursive: true });
    await page.screenshot({ path: `.tmp/chov124/picker-${theme}-${width}.png` });
    await page.keyboard.press("Escape");
    await expect(picker).toBeHidden();
    await expect(choose).toBeFocused();
    await page.keyboard.press("Enter");
    const file = picker.getByRole("treeitem", { name: "legacy.ts", exact: true });
    await file.focus();
    await page.keyboard.press("Enter");
    await expect(picker).toBeHidden();
    await expect(choose).toBeFocused();
    await expect(preview.locator('span[title="/project/src/auth/legacy.ts"]')).toBeVisible();
    await choose.click();
    await picker.getByRole("button", { name: "Close conversation resources", exact: true }).click();
    await expect(choose).toBeFocused();
    await choose.click();
    await page.getByRole("button", { name: "Unified", exact: true }).click();
    await expect(picker).toBeHidden();
    if (width === 1440) {
      await choose.click();
      await page.getByRole("button", { name: "Expand right workspace", exact: true }).click();
      await expect(choose).toBeHidden();
      await expect(picker).toHaveCount(0);
      await expect(page.getByRole("tree")).toBeVisible();
      await page.getByRole("button", { name: "Restore split view", exact: true }).click();
      await expect(choose).toBeVisible();
      await expect(picker).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });
}

for (const theme of ["light", "dark"]) {
  test(`picker displays request states and scrolls files: ${theme}`, async ({ page }) => {
    await openChanges(page, theme, 1440);
    const choose = page.getByRole("button", { name: "Choose changed file", exact: true });
    const picker = page.getByRole("dialog", { name: "Choose changed file", exact: true });
    await choose.click();
    await resourceState(page, "loading");
    await expect(picker.getByRole("status")).toContainText("Loading");
    await resourceState(page, "empty");
    await expect(picker.getByRole("status")).toHaveText("No changes");
    await resourceState(page, "unsupported");
    await expect(picker.getByRole("status")).toContainText("Update");
    await expect(picker).not.toContainText("No changes");
    await resourceState(page, "failed");
    await expect(picker.getByRole("alert")).toBeVisible();
    await expect(picker).not.toContainText("No changes");
    await picker.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(picker.getByRole("treeitem", { name: "redirect.ts", exact: true })).toBeVisible();
    await page.evaluate(() => (window as unknown as { __resourceFixture: { failRefresh(): void } }).__resourceFixture.failRefresh());
    await expect(picker.getByRole("alert")).toBeVisible();
    await expect(picker.getByRole("treeitem", { name: "redirect.ts", exact: true })).toBeVisible();
    await page.evaluate(() => (window as unknown as { __resourceFixture: { recover(): void } }).__resourceFixture.recover());
    await picker.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(picker.getByRole("alert")).toHaveCount(0);
    await resourceState(page, "many");
    await expect(picker.getByRole("treeitem", { name: "file-000.ts", exact: true })).toBeVisible();
    await picker.getByRole("treeitem", { name: "file-000.ts", exact: true }).focus();
    await page.keyboard.press("End");
    await expect(picker.getByRole("treeitem", { name: "file-099.ts", exact: true })).toBeVisible();
    await expect(picker.getByRole("button", { name: "Close conversation resources", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
