import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";

for (const theme of ["light", "dark"]) for (const width of [1440, 1024, 390]) {
  test(`conversation resources preserve the workspace and render Pierre diffs: ${theme} ${width}`, async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await mkdir(".tmp/chov96-design", { recursive: true });
    await page.setViewportSize({ width, height: 960 });
    const fixture = `/@fs/${resolve("e2e/fixtures/conversation-resources.tsx")}`;
    await page.route("**/__resources/content?*", route => route.fulfill({ contentType: "text/markdown", body: "# README\n\nExisting workspace preview.\n" }));
    await page.route("**/__test/resources?*", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; await import(${JSON.stringify(fixture)});</script>` }));
    await page.goto(`/__test/resources?theme=${theme}`);
    await expect(page.getByRole("tab", { name: "README.md", exact: true })).toBeVisible();
    if (await page.getByRole("button", { name: "Return to main chat", exact: true }).isVisible()) await page.getByRole("button", { name: "Return to main chat", exact: true }).click();
    const draft = page.getByRole("textbox", { name: "Main draft" }); await draft.fill("Keep this draft");
    const before = (await draft.boundingBox())!.width;
    const opener = page.getByRole("button", { name: "Open conversation resources", exact: true }); await opener.click();
    await expect(page.getByTestId("conversation-resources")).toBeVisible();
    expect((await draft.boundingBox())!.width).toBe(before);
    await expect(page.getByText("login-reference.md", { exact: true })).toBeVisible();
    await page.evaluate(async () => { await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))); });
    await page.screenshot({ path: `.tmp/chov96-design/resources-${theme}-${width}.png` });
    await page.keyboard.press("Escape"); await expect(opener).toBeFocused();
    await opener.click(); await page.getByRole("button", { name: /src\/auth\/redirect.ts/ }).click();
    await expect(page.getByTestId("conversation-change-preview")).toBeVisible();
    await expect(page.getByRole("region", { name: "View changes" }).locator("diffs-container")).toBeVisible();
    await expect(page.getByText("readonly", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Read-only", { exact: true })).toBeVisible();
    if (width === 1440) {
      await expect(page.getByRole("button", { name: "Split", exact: true })).toBeDisabled();
      await page.getByRole("button", { name: "Expand right workspace", exact: true }).click();
      await page.getByRole("button", { name: "Split", exact: true }).click();
      await expect(page.getByRole("button", { name: "Split", exact: true })).toHaveAttribute("aria-pressed", "true");
    }
    if (width === 390) {
      await page.getByRole("button", { name: "Choose changed file", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.getByRole("treeitem", { name: "legacy.ts", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeHidden();
    }
    await page.evaluate(async () => { await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))); });
    await page.screenshot({ path: `.tmp/chov96-design/diff-${theme}-${width}.png` });
    await page.getByRole("button", { name: "Back to resources", exact: true }).click();
    await expect(page.getByTestId("conversation-resources")).toBeVisible();
    await page.keyboard.press("Escape");
    if (width === 1440) await page.getByRole("button", { name: "Restore split view", exact: true }).click();
    if (await page.getByRole("button", { name: "Return to main chat", exact: true }).isVisible()) await page.getByRole("button", { name: "Return to main chat", exact: true }).click();
    await expect(draft).toHaveValue("Keep this draft");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
