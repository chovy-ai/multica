import "./env";
import { expect, test } from "@playwright/test";
import type { AgentGuiInitSnapshot } from "../packages/tutti-agent-gui-host/src/protocol";
import type { ChatSession } from "../packages/core/types";

for (const theme of ["light", "dark"] as const) for (const streaming of [false, true]) test(`renders resource links as navigable mentions in ${theme} (${streaming ? "streaming" : "settled"})`, async ({ page }) => {
  const at = "2026-10-25T09:00:00Z";
  const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const session = { id: "resource-links", workspace_id: "resource-workspace", creator_id: "resource-user", agent_id: "local:codex", title: "Internal resources", status: "active", created_at: at, updated_at: at, has_unread: false } as ChatSession;
  const snapshot: AgentGuiInitSnapshot = { workspaceId: session.workspace_id, workspaceSlug: "acme", userId: session.creator_id, appOrigin: "https://app.example.test", locale: "zh-CN", theme,
    local: true, sideWorkspace: true, hostActive: true, hostVisible: true, activeSessionId: session.id, selectedAgentId: session.agent_id, sessions: [session],
    agents: [{ agent: { id: agentId, name: "程序员鼓励师", workspace_id: session.workspace_id }, iconUrl: "", provider: "claude", canInvoke: true, runtimeBound: true, runtimeOnline: true } as AgentGuiInitSnapshot["agents"][number]],
    executionTargets: [{ id: "local:codex", provider: "codex", name: "Codex", iconUrl: "", canInvoke: true, runtimeBound: true, runtimeOnline: true }] };
  const content = [
    `已创建 [程序员鼓励师](https://app.example.test/acme/agents/${agentId}?view=general#avatar)。`,
    "相关任务：[TES-124 修复问题](/acme/issues/TES-124#comment-1)。",
    `项目：[发布计划](/acme/projects/${projectId})。`,
    `原生 mention：[@程序员鼓励师](mention://agent-target/${agentId}?workspaceId=resource-workspace)。`,
    "外部网站：[开发文档](https://example.org/docs)。",
    `其他工作区：[外部智能体](https://app.example.test/other/agents/${agentId})。`,
    `\`[源码中的链接](https://app.example.test/acme/agents/${agentId})\``,
    "确认页：file:///project/output/cases.html。",
    "改动对照：[查看对照](file:///project/output/cases-detail.html)。",
    "相对文件：`output/review.html`。",
    "带空格的文件：[房间报告](file:///project/output/%E6%88%BF%E9%97%B4%20report.html#L12)。",
    "源文件：/project/src/room.ts:24:3。",
    "网页：https://example.org/guide。",
    "尖括号：<file:///project/output/angle.html>。",
    "引用：[引用报告][report]\n\n[report]: file:///project/output/reference.html",
    "[不可用协议](javascript:alert(1))",
    "```sh\ncat /project/output/cases.html\n```",
    "`cat /project/output/cases.html`",
  ].join("\n\n");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/__test/resource-links", (route) => route.fulfill({ contentType: "text/html", body: '<button id="finish">Finish reply</button><iframe title="Resource test" style="display:block;width:100%;height:900px;border:0"></iframe>' }));
  await page.setViewportSize({ width: 1280, height: 950 });
  await page.goto("/__test/resource-links");
  await page.evaluate(({ snapshot, session, content, at, streaming }) => {
    const frame = document.querySelector("iframe")!;
    let running = streaming;
    const opens: unknown[] = []; const storage = new Map<string, string>();
    window.addEventListener("message", (event) => {
      if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== "multica:agent-gui:ready") return;
      const channel = new MessageChannel();
      document.getElementById("finish")!.onclick = () => { running = false; channel.port1.postMessage({ type: "event", event: { type: "invalidate", scope: "session", sessionId: session.id } }); };
      channel.port1.onmessage = (event) => {
        const request = event.data; if (request.type !== "request") return;
        let result: unknown;
        switch (request.method) {
          case "workspace.load": result = snapshot; break;
          case "session.load": result = { session, messages: [{ id: "reply", chat_session_id: session.id, role: "assistant", content, task_id: "settled-turn", created_at: at }],
            tasks: [{ id: "settled-turn", chat_session_id: session.id, agent_id: session.agent_id, status: running ? "running" : "completed", kind: "chat", created_at: at, completed_at: running ? null : at }], pending: running ? { task_id: "settled-turn", status: "running" } : {} }; break;
          case "host.openInternalResource": opens.push(request.params); document.body.dataset.opens = JSON.stringify(opens); break;
          case "host.openResource": document.body.dataset.preview = request.params.url; break;
          case "storage.read": result = storage.get(request.params.key) ?? null; break;
          case "storage.write": storage.set(request.params.key, request.params.value); break;
          case "task.messages": case "context.tasks": result = []; break;
          case "models.list": result = { id: "models", status: "completed", supported: true, models: [] }; break;
          case "usage.read": result = { provider: "codex", context: { usedTokens: null, limitTokens: null, model: null, updatedAt: null }, account: { status: "unavailable", windows: [] } }; break;
          case "session.watch": case "session.markRead": case "host.selectSession": break;
          default: document.body.dataset.failure = request.method; channel.port1.postMessage({ type: "response", id: request.id, error: { message: request.method } }); return;
        }
        channel.port1.postMessage({ type: "response", id: request.id, result });
      };
      channel.port1.start(); frame.contentWindow!.postMessage({ type: "multica:agent-gui:connect", snapshot }, location.origin, [channel.port2]);
    });
    frame.src = "/tutti-agent-gui/index.html";
  }, { snapshot, session, content, at, streaming });
  const gui = page.frameLocator("iframe");
  const agent = gui.locator('a[data-multica-resource-kind="agent"]').first();
  await expect(agent.locator('[data-slot="mention-pill"]')).toBeVisible();
  await expect(agent).toHaveText("程序员鼓励师");
  await expect(gui.locator('a[data-multica-resource-kind="agent"]')).toHaveCount(2);
  const task = gui.locator('a[data-multica-resource-kind="issue"]');
  await expect(task.locator('[data-slot="mention-pill"]')).toBeVisible();
  await expect(gui.getByText("开发文档", { exact: true })).not.toHaveAttribute("data-multica-resource-kind");
  await expect(gui.getByText("外部智能体", { exact: true })).not.toHaveAttribute("data-multica-resource-kind");
  await expect(gui.locator("code").filter({ hasText: "源码中的链接" })).not.toContainText("mention://");
  const opened = () => page.locator("body").evaluate((body) => JSON.parse(body.dataset.opens || "[]"));
  await agent.click();
  await expect.poll(opened).toEqual([{ href: `/acme/agents/${agentId}?view=general#avatar`, background: false }]);
  await task.focus(); await task.press("Enter");
  await expect.poll(async () => (await opened()).length).toBe(2);
  expect((await opened())[1]).toEqual({ href: "/acme/issues/TES-124#comment-1", background: false });
  await gui.locator('a[data-multica-resource-kind="project"]').click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(async () => (await opened()).length).toBe(3);
  expect((await opened())[2]).toEqual({ href: `/acme/projects/${projectId}`, background: true });
  await expect(page.locator("body")).not.toHaveAttribute("data-preview");
  const preview = () => page.locator("body").getAttribute("data-preview");
  const file = gui.getByRole("link", { name: "file:///project/output/cases.html", exact: true });
  await expect(file).toBeVisible();
  await file.click();
  await expect.poll(preview).toBe("/project/output/cases.html");
  await gui.getByRole("link", { name: "查看对照", exact: true }).click();
  await expect.poll(preview).toBe("/project/output/cases-detail.html");
  await gui.getByRole("link", { name: "output/review.html", exact: true }).click();
  await expect.poll(preview).toBe("output/review.html");
  await expect.poll(() => gui.getByRole("link", { name: "output/review.html", exact: true }).locator("code").evaluate((code) => getComputedStyle(code).color === getComputedStyle(code.closest("a")!).color)).toBe(true);
  await gui.getByRole("link", { name: "房间报告", exact: true }).click();
  await expect.poll(preview).toBe("/project/output/%E6%88%BF%E9%97%B4%20report.html:12");
  const line = gui.getByRole("link", { name: "/project/src/room.ts:24:3", exact: true });
  await line.focus(); await line.press("Enter");
  await expect.poll(preview).toBe("/project/src/room.ts:24");
  await gui.getByRole("link", { name: "https://example.org/guide", exact: true }).click();
  await expect.poll(preview).toBe("https://example.org/guide");
  await gui.getByRole("link", { name: "file:///project/output/angle.html", exact: true }).click();
  await expect.poll(preview).toBe("/project/output/angle.html");
  if (streaming) await page.getByRole("button", { name: "Finish reply", exact: true }).click();
  await gui.getByRole("link", { name: "引用报告", exact: true }).click();
  await expect.poll(preview).toBe("/project/output/reference.html");
  await expect(gui.getByRole("link", { name: "不可用协议", exact: true })).toHaveCount(0);
  await expect(gui.locator("pre a")).toHaveCount(0);
  await expect(gui.getByRole("link", { name: "cat /project/output/cases.html", exact: true })).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveAttribute("data-failure");
  expect(errors).toEqual([]);
  await page.screenshot({ path: `.tmp/local-conversations/resource-mentions-${theme}-${streaming ? "streaming" : "settled"}.png` });
});
