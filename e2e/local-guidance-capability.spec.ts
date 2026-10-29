import "./env";
import { expect, test } from "@playwright/test";
import type { AgentGuiInitSnapshot } from "../packages/tutti-agent-gui-host/src/protocol";

for (const provider of ["codex", "claude"] as const) for (const theme of ["light", "dark"] as const) {
  test(`${provider} ${theme} retains unsupported guidance and queues explicit agent mentions while awaiting an answer`, async ({ page }) => {
    await page.route("**/__test/guidance", (route) => route.fulfill({ contentType: "text/html", body: '<iframe title="Guidance test" style="display:block;width:100%;height:900px;border:0"></iframe>' }));
    await page.setViewportSize({ width: 1200, height: 940 });
    await page.goto("/__test/guidance");
    await page.evaluate(({ provider, theme }) => {
      const frame = document.querySelector("iframe")!;
      const at = new Date().toISOString();
      const session = { id: "guidance-session", workspace_id: "workspace", creator_id: "user", agent_id: `local:${provider}`, title: "排查 Markdown", status: "active" as const, created_at: at, updated_at: at, has_unread: false };
      const snapshot: AgentGuiInitSnapshot = { workspaceId: "workspace", workspaceSlug: "test", userId: "user", locale: "zh-CN", theme, local: true, queueOwner: "desktop", hostActive: true, hostVisible: true,
        agents: [{ agent: { id: "bug-agent", name: "Multica 捉虫高手", archived_at: null } as AgentGuiInitSnapshot["agents"][number]["agent"], provider: "codex", iconUrl: "", canInvoke: true, runtimeBound: true, runtimeOnline: true }],
        sessions: [session], activeSessionId: session.id, selectedAgentId: session.agent_id,
        executionTargets: [{ id: session.agent_id, provider, name: provider === "codex" ? "Codex" : "Claude Code", iconUrl: "", canInvoke: true, runtimeBound: true, runtimeOnline: true }] };
      const task = { id: "active-turn", chat_session_id: session.id, status: "running", created_at: at, started_at: at };
      const question = { turnId: task.id, question: { request_id: "scope", status: "pending", createdAt: at, updatedAt: at, questions: [{ id: "scope", header: "排查范围", question: "请提供项目代码目录", options: [], multiSelect: false, allowFreeText: true }] } };
      const queue = { revision: 0, paused: false, items: [] as unknown[] };
      const calls: { method: string; params: Record<string, unknown> }[] = [];
      Object.assign(window, { guidanceCalls: calls });
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== "multica:agent-gui:ready") return;
        const channel = new MessageChannel();
        window.addEventListener("append-guidance-draft", (event) => channel.port1.postMessage({ type: "event", event: {
          type: "appendPrompt", sequence: 1, prompt: (event as CustomEvent<string>).detail, sessionId: session.id,
        } }));
        channel.port1.onmessage = (event) => {
          const request = event.data;
          if (request.type !== "request") return;
          calls.push({ method: request.method, params: request.params });
          let result: unknown;
          switch (request.method) {
            case "workspace.load": result = { ...snapshot, pendingTasks: [{ task_id: task.id, status: "running", chat_session_id: session.id }] }; break;
            case "session.load": result = { session, messages: [{ id: "first", chat_session_id: session.id, task_id: task.id, role: "user", content: "排查问题", created_at: at }], questions: [question], tasks: [task], pending: { task_id: task.id, status: "running", created_at: at }, promptQueue: queue }; break;
            case "queue.enqueue": queue.items.push(request.params.item); queue.revision++; result = queue; break;
            case "queue.update": queue.items = []; queue.revision++; result = queue; break;
            case "storage.read": result = null; break;
            case "storage.write": case "session.watch": case "session.markRead": case "host.selectSession": case "host.promptApplied": break;
            case "task.messages": case "context.tasks": result = []; break;
            case "models.list": result = { supported: true, models: [] }; break;
            case "usage.read": result = { provider, context: { usedTokens: null, limitTokens: null, model: null, updatedAt: null }, account: { status: "unavailable", plan: null, windows: [], updatedAt: null } }; break;
            default: document.body.dataset.failure = `Unexpected ${request.method}`; channel.port1.postMessage({ type: "response", id: request.id, error: { message: document.body.dataset.failure } }); return;
          }
          channel.port1.postMessage({ type: "response", id: request.id, result });
        };
        channel.port1.start();
        frame.contentWindow!.postMessage({ type: "multica:agent-gui:connect", snapshot }, location.origin, [channel.port2]);
      });
      frame.src = "/tutti-agent-gui/index.html";
    }, { provider, theme });
    const gui = page.frameLocator("iframe");
    await expect(gui.getByText("请提供项目代码目录", { exact: true })).toBeVisible();
    const editor = gui.locator('[contenteditable="true"]');
    const draft = "[@Multica 捉虫高手](mention://agent-target/bug-agent?workspaceId=workspace) 帮我记个优化";
    await page.evaluate((draft) => window.dispatchEvent(new CustomEvent("append-guidance-draft", { detail: draft })), draft);
    await expect(editor.locator('[data-node-view-wrapper][data-agent-mention-kind="agent-target"]')).toContainText("Multica 捉虫高手");
    for (const modifier of ["Meta", "Control"]) {
      await editor.press(`${modifier}+Enter`);
      await expect(gui.getByText("当前连接不支持引导当前回复。请使用普通发送排队，或先提交当前问题的回答。", { exact: true })).toBeVisible();
      await expect(editor).toContainText("帮我记个优化");
      expect(await page.evaluate(() => (window as unknown as { guidanceCalls: { method: string }[] }).guidanceCalls.filter(({ method }) => ["queue.enqueue", "interaction.respond", "session.cancel"].includes(method)))).toEqual([]);
    }
    await page.screenshot({ path: `.tmp/local-conversations/guidance-${provider}-${theme}.png` });
    await editor.press("Enter");
    await expect.poll(() => page.evaluate(() => (window as unknown as { guidanceCalls: { method: string }[] }).guidanceCalls.filter(({ method }) => method === "queue.enqueue").length)).toBe(1);
    const admission = await page.evaluate(() => (window as unknown as { guidanceCalls: { method: string; params: { item?: unknown } }[] }).guidanceCalls.find(({ method }) => method === "queue.enqueue")!.params.item);
    expect(admission).toMatchObject({ references: [{ kind: "agent", id: "bug-agent" }] });
    expect(await page.evaluate(() => (window as unknown as { guidanceCalls: { method: string }[] }).guidanceCalls.filter(({ method }) => method === "interaction.respond"))).toEqual([]);
    await expect(page.locator("body")).not.toHaveAttribute("data-failure");
  });
}
