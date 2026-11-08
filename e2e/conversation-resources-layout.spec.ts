import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

async function expectVisibleCode(page: Page) {
  const preview = page.getByTestId("conversation-change-preview");
  const region = preview.getByRole("region", { name: "View changes" });
  const measure = () => region.evaluate(element => {
    const code = element.querySelector("diffs-container")?.shadowRoot?.querySelector("code");
    if (!code) return null;
    // Split mode uses display:contents on code; measure its rendered contents.
    const range = document.createRange();
    range.selectNodeContents(code);
    const region = element.getBoundingClientRect().toJSON();
    const preview = element.closest('[data-testid="conversation-change-preview"]')!.getBoundingClientRect().toJSON();
    return { region, preview, code: range.getBoundingClientRect().toJSON(), visibleHeight: Math.min(region.bottom, preview.bottom, innerHeight) - Math.max(region.top, preview.top, 0) };
  });
  let geometry = await measure();
  await expect.poll(async () => {
    geometry = await measure();
    return Boolean(geometry && geometry.visibleHeight > 200 && geometry.code.height > 0 && geometry.code.y >= geometry.region.y && geometry.code.y < geometry.region.bottom);
  }).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  return geometry;
}

for (const theme of ["light", "dark"]) for (const width of [1440, 1024, 390]) {
  test(`long paths keep code and file selection reachable: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    await page.addInitScript(value => localStorage.setItem("theme", value), theme);
    await page.route("**/__resources/content?*", route => route.fulfill({ contentType: "text/markdown", body: "# README" }));
    await page.goto(`/__test/resources?scenario=long&theme=${theme}`);
    await page.getByRole("button", { name: "Open conversation resources", exact: true }).click();
    await page.getByRole("button", { name: /long-directory/ }).click();
    const initial = await expectVisibleCode(page);
    const path = page.getByTestId("conversation-change-preview").locator('span[title*="long-directory"]');
    await page.getByRole("button", { name: "Back to resources", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(path).toBeFocused();
    await expect(page.locator('[data-slot="tooltip-content"]')).toBeVisible();
    await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(`/project/${"long-directory/".repeat(40)}source.ts`);
    const choose = page.getByRole("button", { name: "Choose changed file", exact: true });
    await expect(choose).toBeVisible();
    await choose.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("treeitem", { name: "source.ts", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expectVisibleCode(page);
    await page.getByRole("region", { name: "View changes" }).focus();
    await page.mouse.move(10, 10);
    await expect(page.locator('[data-slot="tooltip-content"]')).toBeHidden();
    await mkdir(".tmp/chov96-layout", { recursive: true });
    await page.screenshot({ path: `.tmp/chov96-layout/long-${theme}-${width}.png` });
    await writeFile(`.tmp/chov96-layout/long-${theme}-${width}.json`, JSON.stringify(initial, null, 2));

    if (width === 1440) {
      const separator = page.getByRole("separator");
      const handle = (await separator.boundingBox())!;
      // Grow the panel beyond the inline-tree threshold, then drag it narrow.
      await page.mouse.move(handle.x, handle.y + 200);
      await page.mouse.down();
      await page.mouse.move(650, handle.y + 200, { steps: 12 });
      await page.mouse.up();
      await expect(choose).toBeHidden();
      await expect(page.getByRole("tree")).toBeVisible();
      await expectVisibleCode(page);
      const grown = (await separator.boundingBox())!;
      await page.mouse.move(grown.x, grown.y + 200);
      await page.mouse.down();
      await page.mouse.move(1080, grown.y + 200, { steps: 12 });
      await page.mouse.up();
      await expect(choose).toBeVisible();
      await expect(page.getByRole("tree")).toBeHidden();
      const narrow = await expectVisibleCode(page);
      await page.getByRole("button", { name: "Wrap code", exact: true }).click();
      await expectVisibleCode(page);
      await page.screenshot({ path: `.tmp/chov96-layout/drag-narrow-${theme}.png` });
      await writeFile(`.tmp/chov96-layout/drag-narrow-${theme}.json`, JSON.stringify(narrow, null, 2));
      await page.getByRole("button", { name: "Expand right workspace", exact: true }).click();
      await expect(choose).toBeHidden();
      await page.getByRole("button", { name: "Split", exact: true }).click();
      await expectVisibleCode(page);
      await page.getByRole("button", { name: "Restore split view", exact: true }).click();
      await expect(choose).toBeVisible();
      await expect(page.getByRole("button", { name: "Split", exact: true })).toBeDisabled();
      await expectVisibleCode(page);
    }
  });
}
