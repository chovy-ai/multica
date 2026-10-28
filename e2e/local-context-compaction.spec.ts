import "./env";
import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import type { AgentGuiInitSnapshot } from "../packages/tutti-agent-gui-host/src/protocol";

for (const provider of ["claude", "codex"] as const) for (const theme of ["light", "dark"] as const) {
  test(`compacts ${provider} context with progress and failure feedback in ${theme} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 1120, height: 900 });
    const at = "2026-10-27T10:00:00Z";
    const session = { id: "local-compact", workspace_id: "test-workspace", creator_id: "test-user", agent_id: `local:${provider}`,
      title: "Context compaction", status: "active" as const, created_at: at, updated_at: at, has_unread: false };
    const snapshot: AgentGuiInitSnapshot = { workspaceId: session.workspace_id, workspaceSlug: "test", userId: session.creator_id,
      locale: "en", theme, local: true, hostActive: true, hostVisible: true, agents: [], sessions: [session], activeSessionId: session.id,
      selectedAgentId: session.agent_id, executionTargets: [{ id: session.agent_id, name: provider === "claude" ? "Claude Code" : "Codex",
        provider, canInvoke: true, runtimeBound: true, runtimeOnline: true, iconUrl: "", model: "test-model" }] };
    await page.route("**/__test/context-compaction", (route) => route.fulfill({ contentType: "text/html", body: '<iframe title="Conversation" style="display:block;width:100%;height:850px;border:0"></iframe>' }));
    await page.goto("/__test/context-compaction");
    await page.evaluate(({ snapshot, session }) => {
      const frame = document.querySelector("iframe")!;
      const storage = new Map<string, string>();
      let complete: (() => void) | undefined, attempts = 0, compacted = false;
      window.addEventListener("test-compact-release", () => complete?.());
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow || event.data?.type !== "multica:agent-gui:ready") return;
        const channel = new MessageChannel(), port = channel.port1;
        port.onmessage = (event) => {
          const request = event.data;
          if (request.type !== "request") return;
          const reply = (result?: unknown) => port.postMessage({ type: "response", id: request.id, result });
          switch (request.method) {
            case "workspace.load": reply(snapshot); break;
            case "session.load": reply({ session, messages: [{ id: "reply", chat_session_id: session.id, role: "assistant", content: "A saved reply with existing context.", created_at: session.created_at, task_id: null }], tasks: [], pending: {} }); break;
            case "storage.read": reply(storage.get(request.params.key) ?? null); break;
            case "storage.write": storage.set(request.params.key, request.params.value); reply(); break;
            case "models.list": reply({ supported: true, models: [{ id: "test-model", label: "Test model" }] }); break;
            case "context.tasks": reply([]); break;
            case "session.watch": case "session.markRead": reply(); break;
            case "usage.read": reply({ provider: snapshot.executionTargets![0]!.provider,
              context: { usedTokens: compacted ? 30000 : 100000, limitTokens: 200000, model: "test-model", updatedAt: session.created_at },
              account: { status: "unavailable", plan: null, windows: [], updatedAt: null }, compaction: { status: complete ? "running" : "ready" } }); break;
            case "session.compact":
              attempts++; document.body.dataset.compactAttempts = String(attempts);
              document.body.dataset.compactSession = request.params.sessionId;
              if (attempts === 1) complete = () => { compacted = true; complete = undefined; reply(); };
              else port.postMessage({ type: "response", id: request.id, error: { message: "Provider connection failed" } });
              break;
            default: document.body.dataset.unexpectedRequest = request.method; reply();
          }
        };
        port.start();
        frame.contentWindow!.postMessage({ type: "multica:agent-gui:connect", snapshot }, location.origin, [channel.port2]);
      });
      frame.src = "/tutti-agent-gui/index.html";
    }, { snapshot, session });
    const gui = page.frameLocator("iframe"), usage = gui.getByTestId("multica-usage-trigger");
    await expect(usage).toContainText("Context 50%");
    await usage.click();
    const compact = gui.getByRole("button", { name: "Compact context", exact: true });
    await expect(compact).toBeEnabled();
    const refresh = gui.getByRole("button", { name: "Refresh usage", exact: true });
    const compactBox = await compact.boundingBox(), refreshBox = await refresh.boundingBox();
    expect(compactBox!.x).toBeLessThan(refreshBox!.x);
    await mkdir(".tmp/chov25", { recursive: true });
    await page.screenshot({ path: `.tmp/chov25/${provider}-${theme}-ready.png`, animations: "disabled" });
    await compact.click();
    await expect(compact).toBeDisabled();
    await expect(gui.getByRole("status").filter({ hasText: "Compacting context" })).toBeVisible();
    await expect(gui.getByRole("region", { name: "Conversation context" })).toContainText("100,000 / 200,000");
    await expect(page.locator("body")).toHaveAttribute("data-compact-session", session.id);
    await page.evaluate(() => window.dispatchEvent(new Event("test-compact-release")));
    await expect(gui.getByRole("status").filter({ hasText: "Context compacted" })).toBeVisible();
    await expect(gui.getByRole("region", { name: "Conversation context" })).toContainText("30,000 / 200,000");
    await expect(compact).toBeEnabled();
    await page.screenshot({ path: `.tmp/chov25/${provider}-${theme}-completed.png`, animations: "disabled" });
    await compact.click();
    await expect(gui.getByRole("alert")).toContainText("Provider connection failed");
    await expect(compact).toBeEnabled();
    await expect(page.locator("body")).toHaveAttribute("data-compact-attempts", "2");
    expect(await page.locator("body").getAttribute("data-unexpected-request")).toBeNull();
  });
}
