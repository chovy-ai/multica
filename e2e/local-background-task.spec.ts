import "./env";
import { expect, test } from "@playwright/test";
import type { AgentGuiInitSnapshot } from "../packages/tutti-agent-gui-host/src/protocol";
import type { LocalBackgroundTask } from "../packages/core/local-conversation/protocol";

for (const theme of ["light", "dark"] as const) test(`background creation adds a durable record in the ${theme} conversation flow without blocking another message`, async ({ page }) => {
  await page.route("**/__test/background-task", (route) => route.fulfill({ contentType: "text/html", body: '<button id="create">Create background task</button><button id="progress">Update background progress</button><button id="finish">Finish background task</button><iframe title="Background task test" style="display:block;width:100%;height:850px;border:0"></iframe>' }));
  await page.setViewportSize({ width: 1100, height: 950 });
  await page.goto("/__test/background-task");
  await page.evaluate((theme) => {
    const frame = document.querySelector("iframe")!;
    const at = new Date(Date.now() - 10000).toISOString();
    const session = { id: "background-session", workspace_id: "background-workspace", creator_id: "user", agent_id: "local:claude", title: "Monitor", status: "active" as const, created_at: at, updated_at: at, has_unread: false };
    const snapshot: AgentGuiInitSnapshot = { workspaceId: session.workspace_id, workspaceSlug: "test", userId: "user", locale: "zh-CN", theme, local: true, hostActive: true, hostVisible: true, agents: [], sessions: [session], activeSessionId: session.id, selectedAgentId: session.agent_id,
      executionTargets: [{ id: session.agent_id, provider: "claude", name: "Claude Code", iconUrl: "", canInvoke: true, runtimeBound: true, runtimeOnline: true }] };
    const messages = [
      { id: "input", chat_session_id: session.id, task_id: "origin", role: "user", content: "Monitor the PR in the background", created_at: at },
      { id: "reply", chat_session_id: session.id, task_id: "origin", role: "assistant", content: "The PR is being monitored separately.", created_at: at },
    ];
    const tasks = [{ id: "origin", chat_session_id: session.id, status: "completed", created_at: at, started_at: at, completed_at: at }];
    const backgroundTasks: { turnId: string; task: LocalBackgroundTask }[] = [];
    let port: MessagePort;
    const invalidate = () => port.postMessage({ type: "event", event: { type: "invalidate", scope: "session", sessionId: session.id } });
    document.querySelector("#create")!.addEventListener("click", () => {
      backgroundTasks.push({ turnId: "origin", task: { id: "watcher", description: "Watch PR #2", status: "running", createdAt: new Date().toISOString() } });
      invalidate();
    });
    document.querySelector("#finish")!.addEventListener("click", () => {
      Object.assign(backgroundTasks[0]!.task, { status: "completed", summary: "PR merged", output: "State: MERGED\nCommit: fixture-commit" });
      invalidate();
    });
    document.querySelector("#progress")!.addEventListener("click", () => {
      Object.assign(backgroundTasks[0]!.task, { progressSummary: "Checking the merge state", lastToolName: "Bash", usage: { totalTokens: 1200, toolUses: 3, durationMs: 4200 } });
      invalidate();
    });
    window.addEventListener("message", (event) => {
      if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== "multica:agent-gui:ready") return;
      const channel = new MessageChannel(); port = channel.port1;
      port.onmessage = (event) => {
        const request = event.data;
        if (request.type !== "request") return;
        let result: unknown;
        switch (request.method) {
          case "workspace.load": result = { ...snapshot, pendingTasks: [] }; break;
          case "session.load": result = { session, messages, tasks, backgroundTasks, pending: {} }; break;
          case "session.send": {
            document.body.dataset.sent = request.params.content;
            const now = new Date().toISOString();
            messages.push({ id: "next-input", chat_session_id: session.id, task_id: "next", role: "user", content: request.params.content, created_at: now });
            messages.push({ id: "next-reply", chat_session_id: session.id, task_id: "next", role: "assistant", content: "Continued while monitoring", created_at: now });
            tasks.push({ id: "next", chat_session_id: session.id, status: "completed", created_at: now, started_at: now, completed_at: now });
            result = { message_id: "next-input", task_id: "next", created_at: now }; break;
          }
          case "storage.read": result = localStorage.getItem(request.params.key); break;
          case "storage.write": localStorage.setItem(request.params.key, request.params.value); break;
          case "task.messages": case "context.tasks": result = []; break;
          case "session.watch": case "session.markRead": case "host.selectSession": break;
          case "models.list": result = { id: "models", status: "completed", supported: true, models: [] }; break;
          case "usage.read": result = { provider: "claude", context: { usedTokens: null, limitTokens: null, model: null, updatedAt: null }, account: { status: "unavailable", plan: null, windows: [], updatedAt: null } }; break;
          default: document.body.dataset.failure = `Unexpected ${request.method}`; port.postMessage({ type: "response", id: request.id, error: { message: document.body.dataset.failure } }); return;
        }
        port.postMessage({ type: "response", id: request.id, result });
      };
      port.start(); frame.contentWindow!.postMessage({ type: "multica:agent-gui:connect", snapshot }, location.origin, [channel.port2]);
    });
    frame.src = "/tutti-agent-gui/index.html";
  }, theme);
  const gui = page.frameLocator("iframe");
  await expect(gui.getByText("The PR is being monitored separately.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create background task" }).click();
  await expect(gui.getByText("后台任务运行中 · Watch PR #2", { exact: true })).toBeVisible();
  await expect(gui.getByText("等待 CLI 更新进度", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Update background progress" }).click();
  await expect(gui.getByRole("status").filter({ hasText: "Checking the merge state" })).toBeVisible();
  await expect(gui.getByText(/耗时 4 秒 · 3 次工具调用 · 1,200 tokens · 最近工具：Bash/)).toBeVisible();
  await expect(gui.getByTestId("agent-gui-composer-stop-active-turn")).toHaveCount(0);
  await gui.locator('[contenteditable="true"]').first().fill("Continue now");
  await gui.getByRole("button", { name: "发送", exact: true }).click();
  await expect(gui.getByText("Continued while monitoring", { exact: true })).toBeVisible();
  await expect(gui.getByText("后台任务运行中 · Watch PR #2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Finish background task" }).click();
  await expect(gui.getByText("后台任务已完成 · Watch PR #2", { exact: true })).toBeVisible();
  await expect(gui.getByText("后台任务运行中 · Watch PR #2", { exact: true })).toHaveCount(0);
  await expect(gui.getByRole("status").filter({ hasText: "PR merged" })).toBeVisible();
  await gui.getByRole("button", { name: "查看详情", exact: true }).click();
  await expect(gui.locator("pre").filter({ hasText: "State: MERGED" })).toBeVisible();
  await expect.poll(() => gui.locator("pre").filter({ hasText: "State: MERGED" }).evaluate((element) => (element.closest(".agent-collapsible-reveal") as HTMLElement | null)?.style.height)).toBe("auto");
  await expect(gui.getByTestId("agent-gui-composer-stop-active-turn")).toHaveCount(0);
  await expect(page.locator("body")).toHaveAttribute("data-sent", "Continue now");
  await expect(page.locator("body")).not.toHaveAttribute("data-failure");
  await page.screenshot({ path: `.tmp/local-conversations/background-record-${theme}.png` });
});
