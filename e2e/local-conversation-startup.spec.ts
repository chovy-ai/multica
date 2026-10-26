import "./env";
import { expect, test } from "@playwright/test";
import type { AgentGuiInitSnapshot } from "../packages/tutti-agent-gui-host/src/protocol";

for (const theme of ["light", "dark"] as const) test(`restores ${theme} conversation UI before announcing that it can be shown`, async ({ page }) => {
  await page.route("**/__test/conversation-startup", (route) => route.fulfill({ contentType: "text/html", body: '<button id="restore">Restore saved state</button><iframe title="Startup test" style="display:block;width:100%;height:850px;border:0"></iframe>' }));
  await page.goto("/__test/conversation-startup");
  await page.evaluate((theme) => {
    const frame = document.querySelector("iframe")!;
    const snapshot: AgentGuiInitSnapshot = { workspaceId: "startup-workspace", workspaceSlug: "test", userId: "startup-user", locale: "en", theme, local: true, hostActive: true, hostVisible: true,
      agents: [], sessions: [], activeSessionId: null, selectedAgentId: "local:codex",
      executionTargets: [{ id: "local:codex", provider: "codex", name: "Codex", iconUrl: "", canInvoke: true, runtimeBound: true, runtimeOnline: true }] };
    let restore = false;
    const pending: Array<() => void> = [];
    document.querySelector("#restore")!.addEventListener("click", () => { restore = true; pending.splice(0).forEach((reply) => reply()); });
    window.addEventListener("message", (event) => {
      if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
      if (event.data?.type === "multica:agent-gui:rendered") {
        document.body.dataset.rendered = "true";
        document.body.dataset.restoredAtRender = String(restore);
        document.body.dataset.themeAtRender = frame.contentDocument!.documentElement.dataset.theme;
        document.body.dataset.composerAtRender = String(Boolean(frame.contentDocument!.querySelector('[data-testid="agent-gui-composer-editor"]')));
        return;
      }
      if (event.data?.type !== "multica:agent-gui:ready") return;
      const channel = new MessageChannel();
      channel.port1.onmessage = ({ data: request }) => {
        if (request.type !== "request") return;
        const reply = (result?: unknown) => channel.port1.postMessage({ type: "response", id: request.id, result });
        switch (request.method) {
          case "storage.read":
            if (!restore) { pending.push(() => reply(null)); document.body.dataset.waitingForRestore = "true"; }
            else reply(null);
            break;
          case "workspace.load": reply(snapshot); break;
          case "context.tasks": reply([]); break;
          case "models.list": reply({ id: "models", status: "completed", supported: true, models: [] }); break;
          case "usage.read": reply({ provider: "codex", context: { usedTokens: null, limitTokens: null, model: null, updatedAt: null }, account: { status: "unavailable", plan: null, windows: [], updatedAt: null } }); break;
          case "storage.write": case "session.watch": case "host.selectSession": case "host.promptApplied": reply(); break;
          default: document.body.dataset.unexpectedRequest = request.method; reply();
        }
      };
      channel.port1.start();
      frame.contentWindow!.postMessage({ type: "multica:agent-gui:connect", snapshot }, location.origin, [channel.port2]);
    });
    frame.src = "/tutti-agent-gui/index.html";
  }, theme);
  const body = page.locator("body");
  await expect(body).toHaveAttribute("data-waiting-for-restore", "true");
  await expect(body).not.toHaveAttribute("data-rendered");
  await page.getByRole("button", { name: "Restore saved state" }).click();
  await expect(body).toHaveAttribute("data-rendered", "true");
  await expect(body).toHaveAttribute("data-restored-at-render", "true");
  await expect(body).toHaveAttribute("data-theme-at-render", theme);
  await expect(body).toHaveAttribute("data-composer-at-render", "true");
  await expect(page.frameLocator("iframe").getByTestId("agent-gui-composer-editor")).toBeVisible();
  await expect(body).not.toHaveAttribute("data-unexpected-request");
});
