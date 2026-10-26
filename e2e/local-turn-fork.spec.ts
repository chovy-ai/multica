import "./env";
import { expect, test } from "@playwright/test";

for (const provider of ["codex", "claude"]) {
  test(`${provider} exposes a fork beside each turn's copy action and opens only the selected prefix`, async ({ page }) => {
    await page.route("**/__test/turn-fork", (route) => route.fulfill({ contentType: "text/html", body: '<button id="source">Return to source</button><iframe title="Turn fork test" style="width:100%;height:900px;border:0"></iframe>' }));
    await page.setViewportSize({ width: 1360, height: 1000 });
    await page.goto("/__test/turn-fork");
    await page.evaluate(({ provider }) => {
      const at = "2026-10-24T18:00:00Z";
      const source = { id: "source", workspace_id: "workspace", creator_id: "user", agent_id: `local:${provider}`, title: "Original conversation", status: "active", created_at: at, updated_at: at, has_unread: false };
      const snapshot = { workspaceId: "workspace", workspaceSlug: "test", userId: "user", local: true, locale: "en", theme: "light", hostActive: true, hostVisible: true, agents: [], sessions: [source], activeSessionId: source.id, selectedAgentId: source.agent_id,
        executionTargets: [{ id: source.agent_id, provider, name: provider === "codex" ? "Codex" : "Claude Code", iconUrl: "", canInvoke: true, canFork: true, runtimeBound: true, runtimeOnline: true }] };
      const messages = ["First question", "BOUNDARY_REPLY", "Future question", "FUTURE_REPLY"].map((content, index) => ({ id: `message-${index}`, chat_session_id: source.id, role: index % 2 ? "assistant" : "user", task_id: index < 2 ? "turn-first" : "turn-future", content, created_at: at }));
      const tasks = ["turn-first", "turn-future"].map((id) => ({ id, chat_session_id: source.id, agent_id: source.agent_id, status: "completed", created_at: at, started_at: at, completed_at: at }));
      const details: Record<string, unknown> = { source: { session: source, messages, tasks, pending: {} } };
      const storage = new Map(); const frame = document.querySelector("iframe")!; let port: MessagePort;
      document.querySelector("#source")!.addEventListener("click", () => { snapshot.activeSessionId = source.id; port.postMessage({ type: "event", event: { type: "init", snapshot } }); });
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== "multica:agent-gui:ready") return;
        const channel = new MessageChannel(); port = channel.port1;
        port.onmessage = (event) => {
          const request = event.data; if (request.type !== "request") return; let result: unknown;
          switch (request.method) {
            case "workspace.load": result = snapshot; break;
            case "session.load": result = details[request.params.sessionId]; break;
            case "session.fork": {
              document.body.dataset.forkTurn = request.params.turnId;
              const branch = { ...source, id: "branch", title: "Original conversation · Fork" };
              snapshot.sessions.push(branch);
              details.branch = { session: branch, model: "chosen-model", messages: messages.slice(0, 2).map((message) => ({ ...message, id: `branch-${message.id}`, chat_session_id: branch.id, task_id: "branch-turn" })), tasks: [{ ...tasks[0], id: "branch-turn", chat_session_id: branch.id }], pending: {},
                forkedFrom: { sessionId: source.id, turnId: request.params.turnId, targetTurnId: "branch-turn", operationId: branch.id, createdAt: at } };
              result = branch; break;
            }
            case "host.selectSession": snapshot.activeSessionId = request.params.sessionId; document.body.dataset.selected = request.params.sessionId; port.postMessage({ type: "event", event: { type: "init", snapshot } }); break;
            case "context.tasks": case "task.messages": result = []; break;
            case "storage.read": result = storage.get(request.params.key) ?? null; break;
            case "storage.write": storage.set(request.params.key, request.params.value); break;
            case "models.list": result = { id: "models", runtime_id: source.agent_id, status: "completed", supported: true, models: [] }; break;
            case "usage.read": result = { provider, context: { usedTokens: null, limitTokens: null, model: null, updatedAt: null }, account: { status: "unavailable", windows: [], plan: null, updatedAt: null } }; break;
            case "session.watch": case "session.markRead": case "host.promptApplied": break;
            case "host.showMessage": document.body.dataset.guiError = request.params.message; break;
            default: document.body.dataset.unexpectedRequest = request.method; port.postMessage({ type: "response", id: request.id, error: { message: `Unexpected ${request.method}` } }); return;
          }
          port.postMessage({ type: "response", id: request.id, result });
        }; port.start(); frame.contentWindow!.postMessage({ type: "multica:agent-gui:connect", snapshot }, location.origin, [channel.port2]);
      }); frame.src = "/tutti-agent-gui/index.html";
    }, { provider });
    const gui = page.frameLocator("iframe");
    const forks = gui.getByRole("button", { name: "Fork through this turn", exact: true });
    await expect(forks).toHaveCount(2, { timeout: 30_000 });
    const firstRow = gui.locator('[data-agent-message-footer="true"]').filter({ hasText: "BOUNDARY_REPLY" });
    await firstRow.hover();
    const copy = firstRow.getByRole("button", { name: "Copy message", exact: true });
    const fork = firstRow.getByRole("button", { name: "Fork through this turn", exact: true });
    expect((await fork.boundingBox())!.x).toBeGreaterThan((await copy.boundingBox())!.x);
    await fork.click();
    await expect(page.locator("body")).toHaveAttribute("data-fork-turn", "turn-first");
    await expect(page.locator("body")).toHaveAttribute("data-selected", "branch");
    await expect(gui.getByText("BOUNDARY_REPLY", { exact: true })).toBeVisible();
    await expect(gui.getByText("FUTURE_REPLY", { exact: true })).toHaveCount(0);
    await expect(page.locator("body")).not.toHaveAttribute("data-gui-error");
    await expect(page.locator("body")).not.toHaveAttribute("data-unexpected-request");
    await page.getByRole("button", { name: "Return to source" }).click();
    await expect(gui.getByText("FUTURE_REPLY", { exact: true })).toBeVisible();
  });
}
