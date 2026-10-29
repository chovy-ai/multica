import "./env";
import { expect, test } from "@playwright/test";
import type { AgentGuiInitSnapshot, AgentGuiSession, AgentGuiSessionDetail } from "../packages/tutti-agent-gui-host/src/protocol";

for (const provider of ["codex", "claude"] as const) for (const rejectAdmission of [false, true]) {
  test(`${provider}: repeated drafts create once on send${rejectAdmission ? " and recover from first admission rejection" : ""}`, async ({ page }) => {
    const at = "2026-10-29T01:00:00Z";
    const snapshot: AgentGuiInitSnapshot = {
      workspaceId: "workspace", workspaceSlug: "test", userId: "user", locale: "en", theme: "dark", local: true,
      activeSessionId: null, selectedAgentId: `local:${provider}`, agents: [], sessions: [], hostActive: true, hostVisible: true,
      ...(rejectAdmission ? { queueOwner: "desktop" as const } : {}),
      newConversationRequest: { sequence: 1, projectPath: "/example/project" },
      folderProjects: [{ id: "project", title: "Project alpha", path: "/example/project", createdAt: at }],
      executionTargets: ["codex", "claude"].map((id) => ({ id: `local:${id}`, name: id === "codex" ? "Codex" : "Claude Code", provider: id,
        iconUrl: "", canInvoke: true, runtimeBound: true, runtimeOnline: true })),
    };
    await page.route("**/__test/new-conversation", (route) => route.fulfill({ contentType: "text/html", body:
      '<button id="project">New project draft</button><button id="home">New unassigned draft</button><button id="restore">Restore saved session</button><iframe style="display:block;width:100%;height:900px;border:0"></iframe>' }));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/__test/new-conversation");
    await page.evaluate(({ snapshot, at, rejectAdmission, provider }) => {
      const frame = document.querySelector("iframe")!;
      const storage = new Map<string, string>();
      const details = new Map<string, AgentGuiSessionDetail>();
      let port: MessagePort;
      let sequence = 1;
      let creations = 0;
      let sends = 0;
      const admissions: unknown[] = [];
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
                title: "Saved first message", status: "active", pinned: false, has_unread: false, project_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
                localDirectory: { cwd: params.cwd ?? "/automatic", projectPath: params.cwd ?? null } };
              snapshot.sessions.push(session);
              details.set(session.id, { session, messages: [], tasks: [], pending: {} });
              result = session; break;
            }
            case "host.showMessage": document.body.dataset.lastError = params.message; break;
            case "attachment.read": result = { data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ioAAAAASUVORK5CYII=", name: "draft.png", mimeType: "image/png" }; break;
            case "attachment.upload": {
              document.body.dataset.uploads = String(Number(document.body.dataset.uploads ?? 0) + 1);
              result = { id: "draft-image", filename: params.file.name, content_type: params.file.type, size_bytes: params.file.size,
                url: "https://test.invalid/draft.png", markdown_url: "https://test.invalid/draft.png" }; break;
            }
            case "queue.enqueue": {
              admissions.push(params); document.body.dataset.admissions = JSON.stringify(admissions);
              if (admissions.length === 1) {
                port.postMessage({ type: "response", id: request.id, error: { message: "FIRST_ADMISSION_REJECTED",
                  ...(provider === "codex" ? { status: 422, code: "test_rejection" } : {}) } }); return;
              }
              const detail = details.get(params.sessionId)!;
              detail.promptQueue = { revision: 1, paused: false, items: [] };
              detail.messages.push({ id: "first-user", chat_session_id: params.sessionId, role: "user", content: params.item.content,
                attachments: [{ id: "draft-image", filename: "draft.png", content_type: "image/png", size_bytes: 68, url: "https://test.invalid/draft.png" }], created_at: at },
                { id: "first-reply", chat_session_id: params.sessionId, role: "assistant", content: "DRAFT_SUBMITTED_ONCE", task_id: "turn", created_at: at });
              detail.tasks = [{ id: "turn", agent_id: detail.session.agent_id, chat_session_id: params.sessionId,
                status: "completed", created_at: at, started_at: at, completed_at: at } as NonNullable<AgentGuiSessionDetail["tasks"]>[number]];
              result = detail.promptQueue;
              port.postMessage({ type: "event", event: { type: "invalidate", scope: "session", sessionId: params.sessionId } }); break;
            }
            case "queue.update": result = details.get(params.sessionId)!.promptQueue; break;
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
    }, { snapshot, at, rejectAdmission, provider });
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
    if (rejectAdmission) {
      await editor.evaluate((element) => {
        const file = new File([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ioAAAAASUVORK5CYII="), (c) => c.charCodeAt(0))], "draft.png", { type: "image/png" });
        const data = new DataTransfer(); data.items.add(file);
        element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
      });
      await expect(gui.getByTestId("agent-gui-composer-image-draft")).toBeVisible();
      await gui.getByTestId("multica-model-picker").click();
      await gui.getByRole("menuitemradio", { name: "Test model", exact: true }).click();
    }
    await gui.getByRole("button", { name: "Send", exact: true }).click();
    if (rejectAdmission) {
      await expect(page.locator("body")).toHaveAttribute("data-last-error", "FIRST_ADMISSION_REJECTED");
      await expect(gui.getByTestId(/^agent-gui-composer-queued-prompt-/).getByText("KEEP_DRAFT_UNTIL_SEND", { exact: true })).toBeVisible();
      await expect(gui.getByRole("img", { name: "draft.png", exact: true }).first()).toBeVisible();
      await expect(gui.getByTestId("multica-model-picker")).toBeEnabled();
      await expect(editor).toHaveAttribute("contenteditable", "true");
      await editor.fill("NEXT_EDITABLE_DRAFT");
      await expect(gui.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await expect(gui.getByTestId("agent-gui-composer-stop-active-turn")).toBeHidden();
      const attempts = JSON.parse((await page.locator("body").getAttribute("data-admissions"))!);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ sessionId: "saved", item: { attachmentIds: ["draft-image"], model: "test-model" } });
      await page.screenshot({ path: `.tmp/chov37-retry-${provider}.png` });
      await gui.getByRole("button", { name: "Send next", exact: true }).click();
      await expect.poll(async () => JSON.parse((await page.locator("body").getAttribute("data-admissions"))!).length).toBe(2);
      const retried = JSON.parse((await page.locator("body").getAttribute("data-admissions"))!);
      expect(retried[1]).toEqual(retried[0]);
      await expect(page.locator("body")).toHaveAttribute("data-uploads", "1");
    }
    await expect(gui.getByText("DRAFT_SUBMITTED_ONCE", { exact: true })).toBeVisible();
    await expect(gui.getByTestId("agent-gui-timeline").getByText("KEEP_DRAFT_UNTIL_SEND", { exact: true })).toHaveCount(1);
    await expect(gui.getByTestId("agent-gui-composer-stop-active-turn")).toBeHidden();
    await expect(page.locator("body")).toHaveAttribute("data-creations", "1");
    if (!rejectAdmission) await expect(page.locator("body")).toHaveAttribute("data-sends", "1");
    await expect(page.locator("body")).toHaveAttribute("data-create-cwd", "/example/project");
    if (!rejectAdmission) await expect(page.locator("body")).toHaveAttribute("data-sent-content", "KEEP_DRAFT_UNTIL_SEND");
    await page.getByRole("button", { name: "New unassigned draft" }).click();
    await expect(project).toHaveText("No project");
    await expect(page.locator("body")).toHaveAttribute("data-creations", "1");
    await page.getByRole("button", { name: "Restore saved session" }).click();
    await expect(gui.getByText("DRAFT_SUBMITTED_ONCE", { exact: true })).toBeVisible();
    await expect(gui.getByTestId("agent-gui-timeline").getByText("KEEP_DRAFT_UNTIL_SEND", { exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "New unassigned draft" }).click();
    await expect(project).toHaveText("No project");
    await expect(page.locator("body")).toHaveAttribute("data-creations", "1");
    expect(await page.locator("body").getAttribute("data-unexpected")).toBeNull();
    await page.screenshot({ path: `.tmp/chov37-draft-${provider}.png` });
  });
}
