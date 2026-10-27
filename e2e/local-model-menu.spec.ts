import { expect, test } from "@playwright/test";
import type { AgentGuiInitSnapshot } from "../packages/tutti-agent-gui-host/src/protocol";

for (const theme of ["light", "dark"] as const) {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 600, height: 420 }]) {
    test(`keeps model and thinking controls reachable in ${theme} at ${viewport.width}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize(viewport);
      await page.route("**/__test/model-menu", (route) => route.fulfill({ contentType: "text/html", body: '<iframe title="Model menu" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>' }));
      await page.goto("/__test/model-menu");
      const snapshot: AgentGuiInitSnapshot = {
        workspaceId: "menu-workspace", workspaceSlug: "model-menu", userId: "menu-user", locale: "zh-CN", theme,
        local: true, hostActive: true, hostVisible: true, agents: [], sessions: [], activeSessionId: null, selectedAgentId: "local:claude",
        executionTargets: [{ id: "local:claude", provider: "claude", name: "Claude Code", model: "opus-5.5", iconUrl: "", canInvoke: true, runtimeBound: true, runtimeOnline: true }],
      };
      await page.evaluate((snapshot) => {
        const storage = new Map<string, string>();
        const models = ["Default (recommended)", "Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 5.5", "Haiku 4.5", "Sonnet 5", "Opus 5", "Fable 5", "Opus 4.8", "Opus 4.7", "Opus 4.6", "Sonnet 4.6", "Plain"]
          .map((label) => ({ id: label.toLowerCase().replaceAll(" ", "-"), label, ...(label !== "Plain" ? { thinking: { supported_levels: [{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }, { value: "max", label: "Max" }] } } : {}) }));
        const frame = document.querySelector("iframe")!;
        window.addEventListener("message", (event) => {
          if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== "multica:agent-gui:ready") return;
          const channel = new MessageChannel();
          channel.port1.onmessage = (event) => {
            const request = event.data;
            if (request.type !== "request") return;
            let result: unknown;
            switch (request.method) {
              case "workspace.load": result = snapshot; break;
              case "storage.read": result = storage.get(request.params.key) ?? null; break;
              case "storage.write": storage.set(request.params.key, request.params.value); break;
              case "usage.read": result = { provider: "claude", context: { usedTokens: null, limitTokens: null, model: null, updatedAt: null }, account: { status: "unavailable", windows: [] } }; break;
              case "models.list": result = { id: "menu-models", runtime_id: "local:claude", status: "completed", supported: true, models }; break;
              case "context.tasks": case "task.messages": result = []; break;
              case "host.selectSession": case "host.promptApplied": case "session.watch": break;
              default: channel.port1.postMessage({ type: "response", id: request.id, error: { message: `Unexpected request: ${request.method}` } }); return;
            }
            channel.port1.postMessage({ type: "response", id: request.id, result });
          };
          channel.port1.start();
          frame.contentWindow!.postMessage({ type: "multica:agent-gui:connect", snapshot }, location.origin, [channel.port2]);
        });
        frame.src = "/tutti-agent-gui/index.html";
      }, snapshot);
      const gui = page.frameLocator("iframe");
      const opener = gui.getByTestId("multica-model-picker");
      await expect(opener).toBeEnabled({ timeout: 30_000 });
      await opener.click();
      await expect(gui.getByRole("menuitemradio", { name: "Opus 5.5", exact: true })).toBeVisible();
      await page.screenshot({ path: `.tmp/model-menu/${process.env.MODEL_MENU_CAPTURE ?? "after"}-${theme}-${viewport.width}.png`, animations: "disabled" });
      const menu = gui.locator(".multica-model-picker-menu").first();
      const list = gui.locator(".multica-model-picker-list");
      const effort = gui.getByRole("menuitem", { name: "思考强度 默认" });
      await expect(effort).toBeVisible();
      const bounds = (await menu.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
      expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
      const effortBefore = await effort.boundingBox();
      await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      expect(Math.abs((await effort.boundingBox())!.y - effortBefore!.y)).toBeLessThan(1);
      await expect(gui.getByRole("menuitemradio", { name: "Plain", exact: true })).toBeVisible();
      await effort.focus();
      await page.keyboard.press("ArrowRight");
      const high = gui.getByRole("menuitemradio", { name: "高", exact: true });
      await expect(high).toBeVisible();
      await high.focus();
      await page.keyboard.press("Enter");
      await expect(opener).toContainText("高");
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await opener.press("ArrowDown");
      await gui.getByRole("menuitem", { name: "思考强度 高" }).hover();
      await expect(high).toBeChecked();
      const submenu = (await gui.locator(".multica-model-picker-effort-menu").boundingBox())!;
      expect(submenu.x).toBeGreaterThanOrEqual(0);
      expect(submenu.y).toBeGreaterThanOrEqual(0);
      expect(submenu.x + submenu.width).toBeLessThanOrEqual(viewport.width);
      expect(submenu.y + submenu.height).toBeLessThanOrEqual(viewport.height);
      await page.screenshot({ path: `.tmp/model-menu/${theme}-${viewport.width}-effort.png`, animations: "disabled" });
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await opener.press("ArrowDown");
      await gui.getByRole("menuitemradio", { name: "Plain", exact: true }).click();
      await expect(opener).toContainText("Plain");
      await expect(opener).not.toContainText("高");
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await opener.press("ArrowDown");
      await expect(gui.getByText("此模型未提供可用强度", { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(opener).toBeFocused();
      expect(errors).toEqual([]);
    });
  }
}
