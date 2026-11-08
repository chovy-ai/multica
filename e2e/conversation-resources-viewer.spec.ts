import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"]) {
  test(`the read-only viewer follows revisions without replacing its scroll container: ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.route("**/__resources/content?*", route => route.fulfill({ contentType: "text/markdown", body: "# README" }));
    await page.goto(`/__test/resources?scenario=scroll&theme=${theme}`);
    const draft = page.getByRole("textbox", { name: "Main draft" });
    await draft.fill("Keep this draft");
    const input = await draft.elementHandle();
    await page.getByRole("button", { name: "View changes", exact: true }).click();
    const viewer = page.locator(".conversation-change-code-view");
    const container = await viewer.elementHandle();
    const diff = page.getByRole("region", { name: "View changes" }).locator("diffs-container");
    await expect(diff).toContainText("fixture-line-");
    const heights = await diff.evaluate(element => ({
      actual: element.shadowRoot!.querySelector("[data-line]")!.getBoundingClientRect().height,
      role: parseFloat(getComputedStyle(element).getPropertyValue("--text-label--line-height")),
    }));
    expect(heights.actual).toBe(heights.role);
    await expect.poll(() => page.workers().filter(worker => worker.url().includes("diffs")).length).toBe(1);
    const worker = page.workers().find(worker => worker.url().includes("diffs"));
    await viewer.evaluate(element => { element.scrollTop = 18000; });
    const readingTop = await viewer.evaluate(element => element.scrollTop);
    await page.evaluate(() => (window as unknown as { __resourceFixture: { revise(): void } }).__resourceFixture.revise());
    await expect.poll(() => page.evaluate(() => (window as unknown as { __resourceFixture: { detailRevision(): number | undefined } }).__resourceFixture.detailRevision())).toBe(2);
    expect(await container!.evaluate(element => element === document.querySelector(".conversation-change-code-view"))).toBe(true);
    await expect.poll(() => viewer.evaluate(element => element.scrollTop)).toBe(readingTop);
    await viewer.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(diff).toContainText("revision-two");
    await page.getByRole("button", { name: "Wrap code", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(viewer).toBeFocused();
    await page.keyboard.type("readonly");
    await expect(diff).toContainText("revision-two");
    await expect(viewer.locator('textarea, [contenteditable="true"]')).toHaveCount(0);
    expect(await input!.evaluate(element => element === document.querySelector('[aria-label="Main draft"]'))).toBe(true);
    await expect(draft).toHaveValue("Keep this draft");
    await page.getByRole("button", { name: "Back to resources", exact: true }).click();
    await page.getByRole("button", { name: /src\/auth\/redirect.test.ts/ }).click();
    await expect(diff).toContainText("expect");
    expect(page.workers().find(active => active.url().includes("diffs"))).toBe(worker);
  });
}
