import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";

for (const theme of ["light", "dark"]) for (const width of [1100, 390]) {
  test(`tool file evidence stays on one Bash call: ${theme} ${width}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const fixture = `/@fs/${resolve("packages/tutti-agent-gui-host/e2e-harness/tool-result-evidence.tsx")}`;
    await page.setViewportSize({ width, height: 800 });
    await page.route("**/__test/tool-evidence?*", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; await import(${JSON.stringify(fixture)});</script>` }));
    await mkdir(".tmp/chov122-design", { recursive: true });
    for (const scenario of ["before", "full", "paths"]) {
      await page.goto(`/__test/tool-evidence?theme=${theme}&scenario=${scenario}`);
      await expect(page.getByText("1 tool call · Bash · Completed", { exact: true })).toBeVisible();
      await expect(page.getByText("Updated notes successfully.", { exact: true }).first()).toBeVisible();
      if (scenario === "full") await expect(page.getByText("preserve tool result evidence", { exact: false }).first()).toBeVisible();
      if (scenario === "paths") {
        await expect(page.getByText("docs/engineering/agent-memory.md", { exact: true })).toBeVisible();
        await expect(page.getByText("Changes are incomplete; some diffs were not provided.")).toBeVisible();
      }
      if (scenario !== "before") {
        await page.getByText("Result details", { exact: true }).click();
        await expect(page.locator("details[open] pre")).toContainText('"interrupted": false');
        await page.getByText("Result details", { exact: true }).click();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `.tmp/chov122-design/${scenario}-${theme}-${width}.png` });
    }
    expect(errors).toEqual([]);
  });
}
