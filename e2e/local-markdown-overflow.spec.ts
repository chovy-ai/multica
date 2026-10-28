import "./env";
import { readFile } from "node:fs/promises";
import { expect, test, type Locator } from "@playwright/test";

async function expectNoOverflow(markdown: Locator) {
  await expect(markdown).toContainText("END_OF_REPLY");
  const sizes = await markdown.evaluate((element) => ({
    width: element.clientWidth, content: element.scrollWidth,
  }));
  expect(sizes.width).toBeGreaterThan(0);
  expect(sizes.content).toBeLessThanOrEqual(sizes.width);
}

for (const provider of ["codex", "claude"]) {
  for (const theme of ["light", "dark"]) {
    test(`${provider} ${theme}: replies wrap and wide tables scroll locally through resizing and stream completion`, async ({ page }) => {
      const fixture = await readFile(new URL("./fixtures/markdown-overflow.html", import.meta.url), "utf8");
      await page.route("**/__test/markdown-overflow?*", (route) => route.fulfill({ contentType: "text/html", body: fixture }));
      const gui = page.frameLocator('iframe[title="Markdown regression"]');
      const markdown = gui.locator(".agent-gui-conversation__assistant-markdown").last();
      for (const wide of [false, true]) {
        await page.setViewportSize({ width: 1200, height: 1000 });
        await page.goto(`/__test/markdown-overflow?provider=${provider}&theme=${theme}${wide ? "&wide&streaming&side" : ""}`);
        await expect(markdown).toContainText("END_OF_REPLY");
        for (const width of [1200, 720, 420]) {
          await page.setViewportSize({ width, height: 1000 });
          await expectNoOverflow(markdown);
          await expect(markdown.locator("pre")).toContainText("--out-dir ./walkthrough-result");
        }
        if (wide) {
          const table = markdown.locator("[data-multica-markdown-table]").last();
          await expect.poll(() => table.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0);
          await table.focus();
          await table.press("ArrowRight");
          await expect.poll(() => table.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
          await table.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
          await expect(table.locator("td").last()).toBeInViewport();
          await expect(markdown.locator("a").last()).toContainText("Full integration guide");
          await page.evaluate(() => (window as unknown as { finishGeneration: () => void }).finishGeneration());
          await expect(gui.getByRole("button", { name: "Send", exact: true })).toBeVisible();
          await expectNoOverflow(markdown);
          await expect(markdown.locator("table").last().locator("td")).toHaveCount(24);
        }
      }
      expect(await page.locator("body").getAttribute("data-unexpected-request")).toBeNull();
    });
  }
}
