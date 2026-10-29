import "./env";
import { expect, test } from "@playwright/test";
import type { AgentGuiInitSnapshot, AgentGuiSession, AgentGuiSessionDetail } from "../packages/tutti-agent-gui-host/src/protocol";

for (const provider of ["codex", "claude"] as const) {
  test(`opens repeated ${provider} project drafts without creating records, then creates once on send`, async ({ page }) => {
    const at = "2026-10-29T01:00:00Z";
    const snapshot: AgentGuiInitSnapshot = {
      workspaceId: "workspace", workspaceSlug: "test", userId: "user", locale: "en", theme: "dark", local: true,
      activeSessionId: null, selectedAgentId: `local:${provider}`, agents: [], sessions: [], hostActive: true, hostVisible: true,
      newConversationRequest: { sequence: 1, projectPath: "/example/project" },
      folderProjects: [{ id: "project", title: "Project alpha", path: "/example/project", createdAt: at }],
      executionTargets: ["codex", "claude"].map((id) => ({ id: `local:${id}`, name: id === "codex" ? "Codex" : "Claude Code", provider: id,
        iconUrl: "", canInvoke: true, runtimeBound: true, runtimeOnline: true })),
    };
    await page.route("**/__test/new-conversation", (route) => route.fulfill({ contentType: "text/html", body:
      '<button id="project">New project draft</button><button id="home">New unassigned draft</button><button id="restore">Restore saved session</button><iframe style="display:block;width:100%;height:900px;border:0"></iframe>' }));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/__test/new-conversation");
    await page.evaluate(({ snapshot, at }) => {
      const frame = document.querySelector("iframe")!;
      const storage = new Map<string, string>();
      const details = new Map<string, AgentGuiSessionDetail>();
      let port: MessagePort;
      let sequence = 1;
      let creations = 0;
      let sends = 0;
      document.body.dataset.creations = "0";
      const publish = () => port.postMessage({ type: "event", event: { type: "init", snapshot } });
      const openDraft = (projectPath: string | null) => {
        snapshot.newConversationRequest = { sequence: ++sequence, projectPath };
        // A host render may carry the request before the route clears its old selection.
        publish();
        snapshot.activeSessionId = null; publish();
      };
      document.querySelector("#project")!.addEventListener("click", () => openDraft("/example/project"));
      document.querySelector("#home")!.addEventListener("click", () => openDraft(null));
      document.querySelector("#restore")!.addEventListener("click", () => { snapshot.activeSessionId = "saved"; publish(); });
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== "multica:agent-gui:ready") return;
        const channel = new MessageChannel(); port = channel.port1;
        port.onmessage = ({ data: request }) => {
          if (request.type !== "request") return;
          const params = request.params;
          let result: unknown;
          switch (request.method) {
            case "workspace.load": result = snapshot; break;
            case "storage.read": result = storage.get(params.key) ?? null; break;
            case "storage.write": storage.set(params.key, params.value); break;
            case "session.load": result = details.get(params.sessionId); break;
            case "session.create": {
              document.body.dataset.creations = String(++creations);
              document.body.dataset.createCwd = params.cwd ?? "none";
              const session: AgentGuiSession = { id: "saved", agent_id: params.agentId, workspace_id: snapshot.workspaceId, creator_id: snapshot.userId,
                title: "Saved first message", status: "active", pinned: false, has_unread: false, project_id: null, created_at: at, updated_at: at,
                localDirectory: { cwd: params.cwd ?? "/automatic", projectPath: params.cwd ?? null } };
              snapshot.sessions.push(session);
              details.set(session.id, { session, messages: [], tasks: [], pending: {} });
              result = session; break;
            }
            case "session.send": {
              document.body.dataset.sends = String(++sends);
              document.body.dataset.sentContent = params.content;
              const detail = details.get(params.sessionId)!;
              detail.messages.push({ id: "first-user", chat_session_id: params.sessionId, role: "user", content: params.content, task_id: "turn", created_at: at },
                { id: "first-reply", chat_session_id: params.sessionId, role: "assistant", content: "DRAFT_SUBMITTED_ONCE", task_id: "turn", created_at: at });
              detail.tasks = [{ id: "turn", agent_id: detail.session.agent_id, runtime_id: detail.session.agent_id, issue_id: "", chat_session_id: params.sessionId,
                kind: "chat", status: "completed", priority: 0, created_at: at, started_at: at, dispatched_at: at, completed_at: at, result: null, error: null }];
              result = { message_id: "first-user", task_id: "turn", created_at: at }; break;
            }
            case "host.selectSession": snapshot.activeSessionId = params.sessionId; snapshot.selectedAgentId = params.agentId; publish(); break;
            case "models.list": result = { supported: true, models: [{ id: "test-model", label: "Test model" }] }; break;
            case "usage.read": result = { provider: params.agentId.split(":")[1], context: { usedTokens: null, limitTokens: null, model: null, updatedAt: null }, account: { status: "unavailable", windows: [], plan: null, updatedAt: null } }; break;
            case "task.messages": case "context.tasks": result = []; break;
            case "session.watch": case "session.markRead": case "host.promptApplied": break;
            default: document.body.dataset.unexpected = request.method;
              port.postMessage({ type: "response", id: request.id, error: { message: `Unexpected request: ${request.method}` } }); return;
          }
          port.postMessage({ type: "response", id: request.id, result });
        };
        port.start();
        frame.contentWindow!.postMessage({ type: "multica:agent-gui:connect", snapshot }, location.origin, [channel.port2]);
      });
      frame.src = "/tutti-agent-gui/index.html";
    }, { snapshot, at });
    const gui = page.frameLocator("iframe");
    const editor = gui.getByTestId("agent-gui-composer-editor");
    const project = gui.locator("[data-workspace-user-project-trigger-label]:visible");
    await expect(editor).toBeVisible({ timeout: 30_000 });
    await expect(project).toHaveText("Project alpha");
    await editor.fill("KEEP_DRAFT_UNTIL_SEND");
    for (let click = 0; click < 3; click++) await page.getByRole("button", { name: "New project draft", exact: true }).click();
    await expect(project).toHaveText("Project alpha");
    await expect(editor).toContainText("KEEP_DRAFT_UNTIL_SEND");
    await page.getByRole("button", { name: "New unassigned draft" }).click();
    await expect(project).toHaveText("No project");
    await page.getByRole("button", { name: "New project draft", exact: true }).click();
    await expect(project).toHaveText("Project alpha");
    await expect(page.locator("body")).toHaveAttribute("data-creations", "0");
    await gui.getByRole("button", { name: "Send", exact: true }).click();
    await expect(gui.getByText("DRAFT_SUBMITTED_ONCE", { exact: true })).toBeVisible();
    await expect(gui.getByTestId("agent-gui-composer-stop-active-turn")).toBeHidden();
    await expect(page.locator("body")).toHaveAttribute("data-creations", "1");
    await expect(page.locator("body")).toHaveAttribute("data-sends", "1");
    await expect(page.locator("body")).toHaveAttribute("data-create-cwd", "/example/project");
    await expect(page.locator("body")).toHaveAttribute("data-sent-content", "KEEP_DRAFT_UNTIL_SEND");
    await page.getByRole("button", { name: "New unassigned draft" }).click();
    await expect(project).toHaveText("No project");
    await expect(page.locator("body")).toHaveAttribute("data-creations", "1");
    await page.getByRole("button", { name: "Restore saved session" }).click();
    await expect(gui.getByText("DRAFT_SUBMITTED_ONCE", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "New unassigned draft" }).click();
    await expect(project).toHaveText("No project");
    await expect(page.locator("body")).toHaveAttribute("data-creations", "1");
    expect(await page.locator("body").getAttribute("data-unexpected")).toBeNull();
    await page.screenshot({ path: `.tmp/chov37-draft-${provider}.png` });
  });
}
