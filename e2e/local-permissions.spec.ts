import "./env";
import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import type { AgentGuiInitSnapshot } from "../packages/tutti-agent-gui-host/src/protocol";
import type { ChatSession } from "../packages/core/types";

for (const provider of ["codex", "claude"] as const) {
  test(`${provider} permission picker persists per conversation and applies to sends`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const at = "2026-10-24T10:00:00Z";
    const first: ChatSession = { id: "first", workspace_id: "permission-workspace", creator_id: "permission-user", agent_id: `local:${provider}`, title: "Permission session", status: "active", created_at: at, updated_at: at, has_unread: false };
    const snapshot: AgentGuiInitSnapshot = {
      workspaceId: first.workspace_id, workspaceSlug: "permission-test", userId: first.creator_id, locale: "en", theme: provider === "claude" ? "light" : "dark", local: true,
      sidePane: provider === "claude", hostActive: true, hostVisible: true, activeSessionId: first.id, selectedAgentId: first.agent_id,
      agents: [], sessions: [first, { ...first, id: "second", title: "Independent session" }],
      executionTargets: [{ id: first.agent_id, name: provider === "codex" ? "Codex" : "Claude Code", provider, iconUrl: "", canInvoke: true, runtimeBound: true, runtimeOnline: true }],
    };
    await page.route("**/__test/local-permissions", (route) => route.fulfill({ contentType: "text/html", body: '<button id="first">First session</button><button id="second">Second session</button><button id="new">New conversation</button><button id="reload">Reload GUI</button><button id="finish">Finish run</button><button id="chinese">Chinese UI</button><iframe title="Permission GUI" style="display:block;width:100%;height:850px;border:0"></iframe>' }));
    await page.setViewportSize({ width: 1360, height: 940 });
    await page.goto("/__test/local-permissions");
    await page.evaluate(({ snapshot, at }) => {
      const frame = document.querySelector("iframe")!;
      const storage = new Map<string, string>();
      let port: MessagePort;
      let pending: Record<string, string> = {};
      const messages: { id: string; role: string; content: string; chat_session_id: string; task_id: string; created_at: string }[] = [];
      const tasks: { id: string; chat_session_id: string; status: string; created_at: string; completed_at: string }[] = [];
      const select = (id: string) => { snapshot.activeSessionId = id; port.postMessage({ type: "event", event: { type: "init", snapshot } }); };
      document.querySelector("#first")!.addEventListener("click", () => select("first"));
      document.querySelector("#second")!.addEventListener("click", () => select("second"));
      document.querySelector("#new")!.addEventListener("click", () => {
        const created = { ...snapshot.sessions[0]!, id: `new-${snapshot.sessions.length}`, title: "New conversation" };
        snapshot.sessions.push(created); select(created.id);
      });
      document.querySelector("#reload")!.addEventListener("click", () => { frame.src = `/tutti-agent-gui/index.html?test=${crypto.randomUUID()}`; });
      document.querySelector("#chinese")!.addEventListener("click", () => { snapshot.locale = "zh-CN"; frame.src = `/tutti-agent-gui/index.html?test=${crypto.randomUUID()}`; });
      document.querySelector("#finish")!.addEventListener("click", () => {
        tasks.push({ id: pending.task_id!, chat_session_id: "first", status: "completed", created_at: at, completed_at: at });
        pending = {};
        port.postMessage({ type: "event", event: { type: "invalidate", scope: "session", sessionId: "first" } });
      });
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== "multica:agent-gui:ready") return;
        const channel = new MessageChannel(); port = channel.port1;
        port.onmessage = (event) => {
          const request = event.data;
          if (request.type !== "request") return;
          let result: unknown;
          switch (request.method) {
            case "workspace.load": result = snapshot; break;
            case "session.load": result = { session: snapshot.sessions.find((item) => item.id === request.params.sessionId), messages: messages.filter((item) => item.chat_session_id === request.params.sessionId), tasks: tasks.filter((item) => item.chat_session_id === request.params.sessionId), pending: request.params.sessionId === "first" ? pending : {}, ...(request.params.sessionId === "second" ? { permissionMode: "default" } : {}) }; break;
            case "storage.read": result = storage.get(request.params.key) ?? null; break;
            case "storage.write": storage.set(request.params.key, request.params.value); break;
            case "models.list": result = { id: "permission-models", runtime_id: request.params.agentId, supported: true, status: "completed", models: [] }; break;
            case "usage.read": result = { provider: snapshot.executionTargets![0]!.provider, context: { usedTokens: null, limitTokens: null, model: null, updatedAt: null }, account: { status: "unavailable", plan: null, windows: [], updatedAt: null } }; break;
            case "context.tasks": result = []; break;
            case "task.messages": result = []; break;
            case "session.send": {
              document.body.dataset.lastPermission = request.params.permissionMode;
              const taskId = `run-${messages.length}`;
              const messageId = `message-${messages.length}`;
              messages.push({ id: messageId, role: "user", content: request.params.content, chat_session_id: request.params.sessionId, task_id: taskId, created_at: at });
              pending = { task_id: taskId, status: "running", created_at: at };
              result = { message_id: messageId, task_id: taskId, created_at: at }; break;
            }
            case "session.watch": case "session.markRead": case "host.promptApplied": break;
            default: document.body.dataset.unexpectedRequest = request.method; port.postMessage({ type: "response", id: request.id, error: { message: request.method } }); return;
          }
          port.postMessage({ type: "response", id: request.id, result });
        };
        port.start();
        frame.contentWindow!.postMessage({ type: "multica:agent-gui:connect", snapshot }, location.origin, [channel.port2]);
      });
      frame.src = "/tutti-agent-gui/index.html";
    }, { snapshot, at });
    const gui = page.frameLocator('iframe[title="Permission GUI"]');
    const picker = gui.getByRole("button", { name: "Execution permissions", exact: true });
    await expect(picker).toHaveText("Default permissions", { timeout: 30_000 });
    await picker.click();
    await expect(gui.getByRole("menuitemradio", { name: /Full access/ })).toContainText("outside the working directory");
    await gui.getByRole("menuitemradio", { name: /^Auto/ }).click();
    await expect(picker).toHaveText("Auto");
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await expect(picker).toHaveText("Auto");
    await page.getByRole("button", { name: "Reload GUI", exact: true }).click();
    await expect(picker).toHaveText("Auto");
    await page.getByRole("button", { name: "Second session", exact: true }).click();
    await expect(picker).toHaveText("Default permissions");
    await page.getByRole("button", { name: "First session", exact: true }).click();
    await expect(picker).toHaveText("Auto");
    await page.getByRole("button", { name: "Reload GUI", exact: true }).click();
    await expect(picker).toHaveText("Auto");
    await picker.click();
    const menu = gui.getByRole("menu");
    await expect.poll(() => menu.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
    const mention = (await gui.getByRole("button", { name: "Reference or Invoke", exact: true }).boundingBox())!;
    const permission = (await picker.boundingBox())!;
    const permissionGap = permission.x - mention.x - mention.width;
    expect(permissionGap).toBeGreaterThanOrEqual(0);
    expect(permissionGap).toBeLessThanOrEqual(4);
    expect(Math.abs(permission.y + permission.height / 2 - mention.y - mention.height / 2)).toBeLessThanOrEqual(1);
    await mkdir(".tmp/permissions", { recursive: true });
    await page.screenshot({ path: `.tmp/permissions/${provider}-menu.png` });
    await gui.getByRole("menuitemradio", { name: /^Auto/ }).click();
    const editor = gui.getByTestId("agent-gui-composer-editor");
    await editor.fill("Use selected permissions");
    await editor.press("Enter");
    await expect(page.locator("body")).toHaveAttribute("data-last-permission", "auto");
    await expect(picker).toBeDisabled();
    await page.getByRole("button", { name: "Finish run", exact: true }).click();
    await expect(picker).toBeEnabled();
    await picker.click();
    await gui.getByRole("menuitemradio", { name: /^Full access/ }).click();
    await expect(picker).toHaveText("Full access");
    await editor.fill("Use full access in this fake execution only"); await editor.press("Enter");
    await expect(page.locator("body")).toHaveAttribute("data-last-permission", "full-access");
    await page.getByRole("button", { name: "Finish run", exact: true }).click();
    await expect(picker).toBeEnabled();
    await page.getByRole("button", { name: "Chinese UI", exact: true }).click();
    const chinesePicker = gui.getByRole("button", { name: "执行权限", exact: true });
    await expect(chinesePicker).toHaveText("完全访问");
    await chinesePicker.click();
    await expect(gui.getByRole("menuitemradio", { name: /^自动/ })).toContainText("仍可能拒绝操作");
    await expect.poll(() => gui.getByRole("menu").evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
    await page.screenshot({ path: `.tmp/permissions/${provider}-menu-zh.png` });
    await gui.getByRole("menuitemradio", { name: /^完全访问/ }).click();
    await page.keyboard.press("Escape");
    await expect(gui.getByRole("menu")).toBeHidden();
    for (const width of [1360, 760, 520]) {
      await page.setViewportSize({ width, height: 940 });
      const atButton = (await gui.getByTestId("agent-gui-composer-mention-trigger").boundingBox())!;
      const permissionButton = (await chinesePicker.boundingBox())!;
      expect(permissionButton.x - atButton.x - atButton.width, `adjacent to @ at width ${width}`).toBeCloseTo(4, 1);
      expect(Math.abs(permissionButton.y + permissionButton.height / 2 - atButton.y - atButton.height / 2), `vertically aligned at width ${width}`).toBeLessThanOrEqual(1);
    }
    await page.screenshot({ path: `.tmp/permissions/${provider}-compact.png` });
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await expect(chinesePicker).toHaveText("完全访问");
    await page.getByRole("button", { name: "Reload GUI", exact: true }).click();
    await expect(chinesePicker).toHaveText("完全访问");
    await page.getByRole("button", { name: "Second session", exact: true }).click();
    await expect(chinesePicker).toHaveText("默认权限");
    await expect(page.locator("body")).not.toHaveAttribute("data-unexpected-request");
    expect(errors).toEqual([]);
  });
}
