import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

test.beforeAll(() => {
  execFileSync("go", ["-C", "server", "test", "./internal/localconversation/service", "-run", "TestMultiFileRunnerEvidenceCanBeReadWithoutTranscriptHistory|TestVerificationFailedCreateIsAbsentFromResources", "-count=1"], { env: { ...process.env, MULTICA_RESOURCE_EVIDENCE_DIR: resolve(".tmp/chov96-runner") }, timeout: 60_000 });
});

async function openFixture(page: Page, query = "") {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.route("**/__resources/content?*", route => {
    const path = new URL(route.request().url()).searchParams.get("path") ?? "";
    if (path.endsWith("/html")) return route.fulfill({ contentType: "text/html", body: "<h1>HTML output</h1>" });
    if (path.endsWith("/image")) return route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64") });
    return route.fulfill({ contentType: "text/markdown", body: path.endsWith("/one") ? "# First attachment" : path.endsWith("/two") ? "# Second attachment" : "# README\n\nExisting preview" });
  });
  await page.goto(`/__test/resources?${query}`);
  await expect(page.getByRole("textbox", { name: "Main draft" })).toBeVisible();
}
async function openResources(page: Page) {
  await page.getByRole("button", { name: "Open conversation resources", exact: true }).click();
  await expect(page.getByTestId("conversation-resources")).toBeVisible();
}
async function settleScreenshot(page: Page, name: string) {
  await mkdir(".tmp/chov96-rework", { recursive: true });
  await page.evaluate(async () => { await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))); });
  await page.screenshot({ path: `.tmp/chov96-rework/${name}.png` });
}

for (const provider of ["codex", "claude"]) {
  test(`renders both files from persisted ${provider} runner evidence without history reads`, async ({ page }) => {
    await openFixture(page, `proof=${provider}`); await openResources(page);
    for (const name of ["edited.ts", "created.ts"]) await expect(page.getByRole("button", { name: new RegExp(name) })).toBeVisible();
    await page.getByRole("button", { name: /edited.ts/ }).click();
    await expect(page.getByRole("region", { name: "View changes" }).locator("diffs-container")).toContainText("B");
    await page.getByRole("button", { name: "Choose changed file", exact: true }).click();
    const tree = page.getByRole("treeitem", { name: "created.ts", exact: true }); await tree.focus(); await page.keyboard.press("Enter");
    await expect(page.getByRole("region", { name: "View changes" }).locator("diffs-container")).toContainText("new");
    await expect(page.getByRole("tab", { name: "Changes", exact: true })).toHaveCount(1);
    const requests = await page.evaluate(() => (window as unknown as { __resourceFixture: { requests(): string[] } }).__resourceFixture.requests());
    expect(requests.some(path => /history|turns\?/.test(path))).toBe(false);
    await settleScreenshot(page, `${provider}-persisted-multi-file`);
  });
}

test("shows the conversation resource empty state after a failed add without a write", async ({ page }) => {
  await openFixture(page, "proof=no-write"); await openResources(page);
  await expect(page.getByTestId("conversation-resources").getByRole("status")).toHaveText("No conversation resources");
  await expect(page.getByText("never-created.ts", { exact: false })).toHaveCount(0);
  await settleScreenshot(page, "failed-add-empty");
});

test("full workspace retains all 20 tabs and reuses Changes after one tab closes", async ({ page }) => {
  await openFixture(page, "scenario=full"); await openResources(page);
  await page.getByRole("button", { name: /src\/auth\/redirect.ts/ }).click();
  expect(await page.locator("body").getAttribute("data-error")).toContain("20 tabs");
  await expect(page.getByRole("tab")).toHaveCount(20);
  await expect(page.getByRole("tab", { name: "Changes", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Close README-0.md", exact: true }).click();
  await openResources(page); await page.getByRole("button", { name: /src\/auth\/redirect.ts/ }).click();
  await expect(page.getByRole("tab", { name: "Changes", exact: true })).toHaveCount(1);
  await expect(page.getByRole("tab")).toHaveCount(20);
  await page.getByRole("button", { name: "Back to resources", exact: true }).click();
  await page.getByRole("button", { name: /src\/auth\/redirect.test.ts/ }).click();
  await expect(page.getByRole("tab")).toHaveCount(20);
  await expect(page.getByRole("region", { name: "View changes" }).locator("diffs-container")).toContainText("expect");
  await page.getByRole("button", { name: "Choose changed file", exact: true }).click();
  await expect(page.getByRole("treeitem", { selected: true })).toHaveCount(1);
  await expect(page.getByRole("treeitem", { name: "redirect.test.ts", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("initial error retries, and refresh errors retain the last resource snapshot", async ({ page }) => {
  await openFixture(page, "scenario=read-error"); await openResources(page);
  await expect(page.getByRole("alert")).toBeVisible();
  await page.evaluate(() => (window as unknown as { __resourceFixture: { recover(): void } }).__resourceFixture.recover());
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("button", { name: /src\/auth\/redirect.ts/ })).toBeVisible();
  await page.evaluate(() => (window as unknown as { __resourceFixture: { failRefresh(): void } }).__resourceFixture.failRefresh());
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button", { name: /src\/auth\/redirect.ts/ })).toBeVisible();
  await settleScreenshot(page, "refresh-error-retains-snapshot");
});

test("omits the partial coverage notice from the resources popover", async ({ page }) => {
  await openFixture(page, "scenario=partial");
  await openResources(page);
  const resources = page.getByTestId("conversation-resources");
  await expect(resources.getByRole("heading", { name: "Outputs" })).toBeVisible();
  await expect(resources).not.toContainText(/only changes recorded since|capture budget exceeded/i);
  await expect(resources.getByText("Current conversation total")).toHaveCount(0);
  await resources.getByRole("button", { name: /src\/auth\/redirect\.ts/ }).click();
  await expect(page.getByTestId("conversation-change-preview")).toContainText("Capture budget exceeded");
});

test("keeps the change count unknown when partial coverage found no files", async ({ page }) => {
  await openFixture(page, "scenario=partial-empty");
  await openResources(page);
  const resources = page.getByTestId("conversation-resources");
  await expect(resources.getByRole("button", { name: "output.png" })).toBeVisible();
  await expect(resources.getByText("Changes · —", { exact: true })).toBeVisible();
  await expect(resources.getByText("Current conversation total")).toHaveCount(0);
  await expect(resources.getByText("No changes", { exact: true })).toHaveCount(0);
});

test("shows an empty state when incomplete capture recorded no resources", async ({ page }) => {
  await openFixture(page, "scenario=unrecorded"); await openResources(page);
  const resources = page.getByTestId("conversation-resources");
  await expect(resources.getByRole("status")).toHaveText("No resources recorded");
  await expect(resources.getByText("Changes · —", { exact: true })).toHaveCount(0);
});

for (const scenario of ["empty", "history", "unsupported", "limit", "long"]) {
  test(`resource state remains usable: ${scenario}`, async ({ page }) => {
    await openFixture(page, `scenario=${scenario}`); await openResources(page);
    if (scenario === "empty") await expect(page.getByText("Changes · 0", { exact: true })).toBeVisible();
    if (scenario === "history") await expect(page.getByTestId("conversation-resources")).toContainText("baseline");
    if (scenario === "unsupported") await expect(page.getByTestId("conversation-resources")).toContainText("Update");
    if (scenario === "limit" || scenario === "long") {
      await page.getByTestId("conversation-resources").getByRole("button", { name: /src\/auth\/redirect.ts|long-directory/ }).click();
      if (scenario === "limit") await expect(page.getByRole("region", { name: "View changes" })).toContainText("limit");
      else await expect(page.getByRole("region", { name: "View changes" }).locator("diffs-container")).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await settleScreenshot(page, scenario);
  });
}

test("output and same-name attachments use their own existing previews", async ({ page }) => {
  await openFixture(page, "scenario=attachments"); await openResources(page);
  const outputs = page.getByTestId("conversation-resources").getByRole("region", { name: "Outputs" });
  expect(await outputs.evaluate(element => element.scrollHeight)).toBe(await outputs.evaluate(element => element.clientHeight));
  await page.getByTestId("conversation-resources").getByRole("button", { name: "reference.md", exact: true }).nth(0).click();
  await expect(page.getByRole("heading", { name: "First attachment" })).toBeVisible();
  await openResources(page); await page.getByTestId("conversation-resources").getByRole("button", { name: "reference.md", exact: true }).nth(1).click();
  await expect(page.getByRole("heading", { name: "Second attachment" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "reference.md", exact: true })).toHaveCount(2);
  await openResources(page); await page.getByRole("button", { name: "report.html", exact: true }).click();
  await expect(page.frameLocator('iframe[title="report.html"]').getByRole("heading", { name: "HTML output" })).toBeVisible();
  await openResources(page); await page.getByRole("button", { name: "output.png", exact: true }).click();
  await expect(page.getByRole("img", { name: "output.png", exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "output.png", exact: true })).toHaveJSProperty("naturalWidth", 1);
});

for (const width of [1440, 390]) test(`opens an output image at a larger size and restores focus on close: ${width}`, async ({ page }) => {
  await openFixture(page, "scenario=attachments");
  await page.route(url => url.pathname === "/__resources/content" && url.searchParams.get("path") === "/attachments/image", route =>
    route.fulfill({ path: resolve("apps/desktop/resources/icon.png"), contentType: "image/png" }));
  await openResources(page);
  await page.getByRole("button", { name: "output.png", exact: true }).click();
  await page.setViewportSize({ width, height: width === 390 ? 720 : 960 });
  const trigger = page.getByRole("button", { name: "Enlarge image output.png" });
  const inlineImage = trigger.getByRole("img", { name: "output.png" });
  await expect(inlineImage).toHaveJSProperty("naturalWidth", 1024);
  const inlineWidth = (await inlineImage.boundingBox())!.width;
  const imageUrl = (await inlineImage.getAttribute("src"))!;

  await inlineImage.click();
  const dialog = page.getByRole("dialog", { name: "output.png" });
  const enlargedImage = dialog.getByRole("img", { name: "output.png" });
  await expect(enlargedImage).toHaveJSProperty("naturalWidth", 1024);
  await expect(enlargedImage).toHaveAttribute("src", imageUrl);
  expect((await enlargedImage.boundingBox())!.width).toBeGreaterThan(inlineWidth);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close image preview" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("tab", { name: "output.png" })).toHaveAttribute("aria-selected", "true");
});

test("scrolls long output lists inside the resources popover", async ({ page }) => {
  await openFixture(page, "scenario=many-outputs"); await openResources(page);
  const resources = page.getByTestId("conversation-resources");
  const outputs = resources.getByRole("region", { name: "Outputs" });
  const lastOutput = outputs.getByRole("button", { name: "output-9.png" });
  await expect(outputs.getByRole("button")).toHaveCount(10);
  expect(await outputs.evaluate(element => element.clientHeight)).toBe(200);
  await expect(lastOutput).not.toBeInViewport();

  await outputs.hover();
  await page.mouse.wheel(0, 640);
  await expect(lastOutput).toBeInViewport();
  expect(await resources.evaluate(element => element.scrollTop)).toBe(0);
  await expect(resources.getByRole("heading", { name: "Outputs" })).toBeInViewport();

  await lastOutput.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: "output-9.png" })).toHaveAttribute("aria-selected", "true");
});

test("early changes remain available with only five recent turns and multiple resource pages", async ({ page }) => {
  await openFixture(page, "scenario=paged"); await openResources(page);
  await expect(page.getByText("Changes · 203", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /early\/file-/ })).toHaveCount(203);
  await expect(page.getByRole("button", { name: /early\/file-000.ts/ })).toBeVisible();
  const requests = await page.evaluate(() => (window as unknown as { __resourceFixture: { requests(): string[] } }).__resourceFixture.requests());
  expect(requests.some(path => path.includes("resources?cursor="))).toBe(true);
  expect(requests.some(path => path.includes("history"))).toBe(false);
});
