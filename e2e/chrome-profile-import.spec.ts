import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";

test("Side Chrome profile import hides the native view, preserves focus and fits both themes at narrow widths", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mkdir(".tmp/chrome-profile-design", { recursive: true });
  const fixture = `/@fs/${resolve("e2e/fixtures/chrome-profile-import.tsx")}`;
  await page.route("**/__test/chrome-profile*", (route) => route.fulfill({ contentType: "text/html", body: `<div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; await import(${JSON.stringify(fixture)});</script>` }));
  for (const dark of [false, true]) {
    await page.setViewportSize({ width: dark ? 360 : 1100, height: 800 });
    await page.goto(`/__test/chrome-profile${dark ? "?zh=1" : ""}`);
    await page.locator("html").evaluate((element, value) => element.classList.toggle("dark", value), dark);
    const opener = page.getByRole("button", { name: dark ? "导入 Chrome 配置" : "Import Chrome profile", exact: true });
    await expect(opener).toBeVisible();
    await page.screenshot({ path: `.tmp/chrome-profile-design/${dark ? "dark-narrow" : "light-wide"}-toolbar.png` });
    await opener.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(page.locator("body")).toHaveAttribute("data-preview-action", "hide");
    await expect(page.getByRole("radio", { name: /Personal/ })).toBeChecked();
    await page.getByRole("radio", { name: /Work profile/ }).check();
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: `.tmp/chrome-profile-design/${dark ? "dark-narrow" : "light-wide"}-picker.png` });
    await page.getByRole("button", { name: dark ? "导入" : "Import", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(dark ? "已导入 7 项 Cookie" : "Imported 7 cookies");
    const payload = JSON.parse((await page.locator("body").getAttribute("data-chrome-import"))!);
    expect(payload.scope).toEqual({ userId: "fixture-user", workspaceId: "fixture-workspace" });
    expect(payload.input.profileId).toBe("work");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(page.locator("body")).toHaveAttribute("data-preview-action", "show");
  }
  expect(errors).toEqual([]);
});
