import "./env";
import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import type { AgentGuiInitSnapshot, AgentGuiSession, AgentGuiSessionDetail } from "../packages/tutti-agent-gui-host/src/protocol";

for (const provider of ["codex", "claude"] as const) {
  for (const withProject of [true, false]) {
    test(`keeps ${withProject ? "the directory project" : "no project"} when changing ${provider} models and providers before sending`, async ({ page }) => {
      const at = "2026-10-27T13:00:00Z";
      const target = provider === "codex" ? "claude" : "codex";
      const cwd = withProject ? "/example/project" : "/state/local-conversations/scope/workdirs/initial";
      const session: AgentGuiSession = {
        id: "initial", workspace_id: "test-workspace", creator_id: "test-user", agent_id: `local:${provider}`,
        title: "New conversation", status: "active", pinned: false, has_unread: false,
        created_at: at, updated_at: at, project_id: null,
        localDirectory: { cwd, projectPath: withProject ? cwd : null },
      };
      const snapshot: AgentGuiInitSnapshot = {
        workspaceId: session.workspace_id, workspaceSlug: "test", userId: session.creator_id,
        locale: "en", theme: "dark", local: true, hostActive: true, hostVisible: true,
        activeSessionId: session.id, selectedAgentId: session.agent_id, sessions: [session], agents: [],
        folderProjects: [{ id: "project", title: "Project alpha", path: "/example/project", createdAt: at }],
        executionTargets: ["codex", "claude"].map((id) => ({ id: `local:${id}`, provider: id,
          name: id === "codex" ? "Codex" : "Claude Code", iconUrl: "", canInvoke: true, runtimeBound: true, runtimeOnline: true })),
      };
      await page.route("**/__test/project-context", (route) => route.fulfill({ contentType: "text/html",
        body: '<button id="restore">Restore initial session</button><iframe style="display:block;width:100%;height:900px;border:0"></iframe>' }));
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto("/__test/project-context");
      await page.evaluate(({ snapshot, session }) => {
        const frame = document.querySelector("iframe")!;
        const storage = new Map<string, string>();
        const details = new Map<string, AgentGuiSessionDetail>([[session.id, { session, messages: [], pending: {}, tasks: [] }]]);
        let port: MessagePort;
        const publish = (sessionId: string | null, agentId: string) => {
          snapshot.activeSessionId = sessionId; snapshot.selectedAgentId = agentId;
          port.postMessage({ type: "event", event: { type: "init", snapshot } });
        };
        document.querySelector("#restore")!.addEventListener("click", () => publish(session.id, session.agent_id));
        window.addEventListener("message", (event) => {
          if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== "multica:agent-gui:ready") return;
          const channel = new MessageChannel(); port = channel.port1;
          port.onmessage = ({ data: request }) => {
            if (request.type !== "request") return;
            let result: unknown;
            const params = request.params;
            switch (request.method) {
              case "workspace.load": result = snapshot; break;
              case "storage.read": result = storage.get(params.key) ?? null; break;
              case "storage.write": storage.set(params.key, params.value); break;
              case "session.load": result = details.get(params.sessionId); break;
              case "session.create": {
                document.body.dataset.createCwd = params.cwd ?? "none";
                document.body.dataset.createProvider = params.agentId;
                const cwd = params.cwd || "/state/local-conversations/scope/workdirs/created";
                const created: AgentGuiSession = { ...session, id: "created", agent_id: params.agentId,
                  localDirectory: { cwd, projectPath: params.cwd ?? null } };
                snapshot.sessions.push(created);
                details.set(created.id, { session: created, messages: [], pending: {}, tasks: [] });
                result = created; break;
              }
              case "session.send": {
                const detail = details.get(params.sessionId)!;
                document.body.dataset.sentCwd = detail.session.localDirectory!.cwd;
                detail.messages.push({ id: "user", chat_session_id: params.sessionId, role: "user", content: params.content, task_id: "turn", created_at: session.created_at },
                  { id: "reply", chat_session_id: params.sessionId, role: "assistant", content: "FAKE_DIRECTORY_REPLY", task_id: "turn", created_at: session.created_at });
                result = { message_id: "user", task_id: "turn", created_at: session.created_at }; break;
              }
              case "models.list": result = { supported: true, models: [{ id: "test-model", label: "Test model" }] }; break;
              case "usage.read": result = { provider: params.agentId.split(":")[1], context: { usedTokens: null, limitTokens: null, model: null, updatedAt: null }, account: { status: "unavailable", windows: [], plan: null, updatedAt: null } }; break;
              case "host.selectSession": publish(params.sessionId, params.agentId); break;
              case "task.messages": case "context.tasks": result = []; break;
              case "session.watch": case "session.markRead": case "host.promptApplied": break;
              default:
                document.body.dataset.unexpected = request.method;
                port.postMessage({ type: "response", id: request.id, error: { message: `Unexpected test request: ${request.method}` } }); return;
            }
            port.postMessage({ type: "response", id: request.id, result });
          };
          port.start();
          frame.contentWindow!.postMessage({ type: "multica:agent-gui:connect", snapshot }, location.origin, [channel.port2]);
        });
        frame.src = "/tutti-agent-gui/index.html";
      }, { snapshot, session });
      const gui = page.frameLocator("iframe");
      const editor = gui.getByTestId("agent-gui-composer-editor");
      const project = gui.locator("[data-workspace-user-project-trigger-label]:visible");
      const label = withProject ? "Project alpha" : "No project";
      await expect(editor).toBeVisible({ timeout: 30_000 });
      await expect(project).toHaveText(label);
      await editor.fill("KEEP_DIRECTORY_CONTEXT");
      await gui.getByTestId("multica-model-picker").click();
      await gui.getByRole("menuitemradio", { name: "Test model", exact: true }).click();
      await expect(project).toHaveText(label);
      await gui.getByTestId("multica-agent-picker").click();
      await gui.getByRole("menuitemradio", { name: target === "codex" ? "Codex" : "Claude Code", exact: true }).click();
      await expect(gui.getByTestId("multica-agent-picker")).toContainText(target === "codex" ? "Codex" : "Claude Code");
      await expect(project).toHaveText(label);
      await expect(editor).toContainText("KEEP_DIRECTORY_CONTEXT");
      expect(await page.locator("body").getAttribute("data-create-cwd")).toBeNull();
      if (withProject && provider === "codex") {
        await mkdir(".tmp/local-conversations", { recursive: true });
        await page.screenshot({ path: ".tmp/local-conversations/chov19-directory-retained.png" });
      }
      await gui.getByRole("button", { name: "Send", exact: true }).click();
      await expect(page.locator("body")).toHaveAttribute("data-create-cwd", withProject ? cwd : "none");
      await expect(page.locator("body")).toHaveAttribute("data-create-provider", `local:${target}`);
      await expect(page.locator("body")).toHaveAttribute("data-sent-cwd", withProject ? cwd : "/state/local-conversations/scope/workdirs/created");
      await expect(gui.getByText("FAKE_DIRECTORY_REPLY", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Restore initial session" }).click();
      await expect(project).toHaveText(label);
      await expect(gui.getByTestId("multica-agent-picker")).toContainText(provider === "codex" ? "Codex" : "Claude Code");
      expect(await page.locator("body").getAttribute("data-unexpected")).toBeNull();
    });
  }
}
