import "./env";
import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import type { AgentGuiInitSnapshot, AgentGuiSession } from "../packages/tutti-agent-gui-host/src/protocol";

test("restores local provider drafts and reopens references after switching conversations", async ({ page }) => {
  const at = "2026-10-24T10:00:00Z";
  const session = { id: "local-test-conversation", workspace_id: "test-workspace", creator_id: "test-user", agent_id: "local:codex", title: "Local draft", status: "active", created_at: at, updated_at: at, has_unread: false, localDirectory: { cwd: "/example/project", projectPath: "/example/project" } } as AgentGuiSession;
  const claudeSession = { ...session, id: "local-claude-conversation", agent_id: "local:claude", title: "Existing Claude conversation" };
  const snapshot: AgentGuiInitSnapshot = {
    workspaceId: session.workspace_id, workspaceSlug: "test", userId: session.creator_id,
    locale: "en", theme: "dark", local: true, hostActive: true, hostVisible: true,
    folderProjects: [{ id: "project", title: "Project alpha", path: "/example/project", createdAt: at }],
    agents: [], sessions: [session, claudeSession, { ...claudeSession, id: "delayed-claude", title: "Delayed conversation" }], activeSessionId: session.id, selectedAgentId: "local:codex",
    executionTargets: ["codex", "claude"].map((provider) => ({ id: `local:${provider}`, provider, name: provider === "codex" ? "Codex" : "Claude Code", iconUrl: "", canInvoke: true, runtimeBound: true, runtimeOnline: true })),
  };
  let apiRequests = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests++; });
  await page.route("**/__test/local-provider-gui", (route) => route.fulfill({ contentType: "text/html", body: '<button id="restore">Open original Codex conversation</button><button id="claude">Open existing Claude conversation</button><button id="delayed">Open delayed conversation</button><button id="home">New Codex draft</button><button id="attach">Add test attachment</button><button id="outside" onclick="this.dataset.clicked=\'true\'">Host toolbar</button><input aria-label="Host search"><iframe title="Local provider test" style="display:block;width:100%;height:900px;border:0"></iframe>' }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/__test/local-provider-gui");
  await page.evaluate(({ snapshot, session }) => {
    const storage = new Map<string, string>();
    const frame = document.querySelector("iframe")!;
    let port: MessagePort;
    let releaseDelayed: (() => void) | undefined;
    let retrying = false;
    window.addEventListener("test-retry", (event) => {
      retrying = (event as CustomEvent<boolean>).detail;
      port.postMessage({ type: "event", event: { type: "invalidate", scope: "session", sessionId: session.id } });
    });
    window.addEventListener("release-delayed-session", () => releaseDelayed?.());
    const publishSelection = (sessionId: string | null, agentId: string) => {
      snapshot.activeSessionId = sessionId; snapshot.selectedAgentId = agentId;
      document.body.dataset.selectedProvider = agentId;
      document.body.dataset.selectedSession = sessionId ?? "";
      port.postMessage({ type: "event", event: { type: "init", snapshot } });
    };
    window.addEventListener("test-dismiss-popovers", () => port.postMessage({ type: "event", event: { type: "dismissPopovers" } }));
    document.querySelector("#restore")!.addEventListener("click", () => publishSelection(session.id, "local:codex"));
    document.querySelector("#claude")!.addEventListener("click", () => publishSelection("local-claude-conversation", "local:claude"));
    document.querySelector("#delayed")!.addEventListener("click", () => publishSelection("delayed-claude", "local:claude"));
    document.querySelector("#home")!.addEventListener("click", () => publishSelection(null, "local:codex"));
    document.querySelector("#attach")!.addEventListener("click", () => port.postMessage({ type: "event", event: {
      type: "appendPrompt", sequence: 100, prompt: "[@provider-switch.txt](mention://composer-file/draft-attachment?status=ready)", sessionId: snapshot.activeSessionId,
      attachments: [{ id: "draft-attachment", filename: "provider-switch.txt", content_type: "text/plain", size_bytes: 12, url: "https://files.example.test/provider-switch.txt" }],
    } }));
    window.addEventListener("message", (event) => {
      if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== "multica:agent-gui:ready") return;
      const channel = new MessageChannel(); port = channel.port1;
      port.onmessage = (event) => {
        const request = event.data;
        if (request.type !== "request") return;
        let result: unknown;
        switch (request.method) {
          case "workspace.load": result = snapshot; break;
          case "context.tasks": result = []; break;
          case "session.load": result = { session: snapshot.sessions.find((item) => item.id === request.params.sessionId) ?? session,
            messages: [{ id: `reply-${request.params.sessionId}`, chat_session_id: request.params.sessionId, role: "assistant", content: `Saved reply for ${request.params.sessionId}`, task_id: null, created_at: session.created_at }],
            tasks: [{ id: `run-${request.params.sessionId}`, status: retrying ? "running" : "completed", created_at: session.created_at, ...(retrying ? {} : { completed_at: session.created_at }) }],
            pending: retrying ? { task_id: `run-${request.params.sessionId}`, status: "running", created_at: session.created_at } : {} };
            if (request.params.sessionId === "delayed-claude" && !releaseDelayed) {
              document.body.dataset.delayedRead = "pending";
              releaseDelayed = () => { document.body.dataset.delayedRead = "released"; port.postMessage({ type: "response", id: request.id, result }); };
              return;
            }
            break;
          case "task.messages": result = [2, 3].map((attempt) => ({ task_id: request.params.taskId, issue_id: "", seq: attempt, type: "status", content: `Reconnecting... ${attempt}/5 (stream disconnected before completion: websocket closed by server before response.completed)` })); break;
          case "storage.read": result = storage.get(request.params.key) ?? null; break;
          case "storage.write": storage.set(request.params.key, request.params.value); break;
          case "models.list": result = { id: "test-models", runtime_id: request.params.agentId, status: "completed", supported: true, models: [{ id: "test-model", label: "Test model" }] }; break;
          case "usage.read": {
            const active = snapshot.sessions.find((item) => item.id === request.params.sessionId);
            if (active && active.agent_id !== request.params.agentId) {
              document.body.dataset.wrongUsageProvider = request.params.agentId;
              port.postMessage({ type: "response", id: request.id, error: { message: "Usage provider does not match this conversation" } }); return;
            }
            result = { provider: request.params.agentId === "local:claude" ? "claude" : "codex",
            context: { usedTokens: 20000, limitTokens: 200000, model: "test-model", updatedAt: session.created_at },
            account: { status: request.params.force ? "error" : "available", stale: Boolean(request.params.force), plan: "max", updatedAt: session.created_at,
              windows: [{ id: request.params.agentId === "local:claude" ? "five_hour" : "codex:primary", label: "5h", usedPercent: 22, resetsAt: "2099-01-01T00:00:00Z" }, { id: request.params.agentId === "local:claude" ? "seven_day" : "codex:secondary", label: "7d", usedPercent: 5, resetsAt: "2099-01-05T00:00:00Z" }] } }; break;
          }
          case "host.selectSession": publishSelection(request.params.sessionId, request.params.agentId); break;
          case "session.watch": case "session.markRead": case "host.promptApplied": break;
          default:
            port.postMessage({ type: "response", id: request.id, error: { message: `Unexpected test request: ${request.method}` } });
            document.body.dataset.unexpectedRequest = request.method; return;
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
  const provider = gui.getByRole("button", { name: "Local provider", exact: true });
  const model = gui.getByTestId("multica-model-picker");
  await expect(editor).toBeVisible({ timeout: 30_000 });
  const project = gui.locator("[data-workspace-user-project-trigger-label]:visible");
  await page.getByRole("button", { name: "New Codex draft" }).click();
  await expect(gui.getByRole("heading", { level: 2 })).toBeVisible();
  await editor.fill("HOME_DRAFT_MUST_SURVIVE_PROVIDER_SWITCH");
  await provider.click();
  await gui.getByRole("menuitemradio", { name: "Claude Code", exact: true }).click();
  await expect(provider).toContainText("Claude Code");
  await expect(editor).toContainText("HOME_DRAFT_MUST_SURVIVE_PROVIDER_SWITCH");
  await provider.click();
  await gui.getByRole("menuitemradio", { name: "Codex", exact: true }).click();
  await expect(provider).toContainText("Codex");
  await expect(editor).toContainText("HOME_DRAFT_MUST_SURVIVE_PROVIDER_SWITCH");
  await page.getByRole("button", { name: "Open original Codex conversation" }).click();
  await expect(editor).toBeEmpty();
  await expect(gui.getByText("Saved reply for local-test-conversation", { exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("test-retry", { detail: true })));
  await expect(gui.getByRole("status").filter({ hasText: "Reconnecting... 3/5" })).toBeVisible();
  await expect(gui.getByText(/websocket closed by server/)).not.toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("test-retry", { detail: false })));
  await expect(gui.getByRole("status").filter({ hasText: "Reconnecting..." })).not.toBeVisible();
  await editor.fill("LOCAL_DRAFT_MUST_SURVIVE_PROVIDER_SWITCH");
  await model.click();
  await gui.getByRole("menuitemradio", { name: "Test model", exact: true }).click();
  await expect(model).toContainText("Test model");
  await expect(model).toBeFocused();
  await mkdir(".tmp/local-conversations", { recursive: true });
  const usage = gui.getByTestId("multica-usage-trigger");
  await expect(usage).toContainText("Context 10%");
  await expect(usage).toContainText("left 78%");
  await usage.click();
  await expect(gui.getByRole("region", { name: "Conversation context" })).toContainText("20,000 / 200,000 tokens");
  await expect(gui.getByRole("progressbar", { name: "5-hour window" })).toHaveAttribute("aria-valuenow", "78");
  await expect(gui.getByRole("progressbar", { name: "Weekly window" })).toHaveAttribute("aria-valuenow", "95");
  await gui.getByRole("button", { name: "Refresh usage", exact: true }).click();
  await expect(gui.getByText("Update failed; showing previous data", { exact: true })).toBeVisible();
  await page.screenshot({ path: ".tmp/local-conversations/08-provider-usage.png" });
  await page.getByRole("button", { name: "Host toolbar" }).click();
  await expect(gui.getByRole("region", { name: "Conversation context" })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Host toolbar" })).toHaveAttribute("data-clicked", "true");
  await usage.click();
  await expect(gui.getByRole("region", { name: "Conversation context" })).toBeVisible();
  await page.getByRole("textbox", { name: "Host search" }).click();
  await expect(gui.getByRole("region", { name: "Conversation context" })).not.toBeVisible();
  await expect(page.getByRole("textbox", { name: "Host search" })).toBeFocused();
  await usage.click();
  await expect(gui.getByRole("region", { name: "Conversation context" })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("test-dismiss-popovers")));
  await expect(gui.getByRole("region", { name: "Conversation context" })).not.toBeVisible();
  await usage.click();
  await editor.click({ position: { x: 8, y: 8 } });
  await expect(gui.getByRole("region", { name: "Conversation context" })).not.toBeVisible();
  await editor.press("End");
  await usage.click();
  await gui.getByRole("button", { name: "Refresh usage", exact: true }).press("Escape");
  await gui.getByTestId("agent-gui-composer-mention-trigger").click();
  await gui.getByRole("option").filter({ hasText: "Existing Claude conversation" }).click();
  await editor.press("Escape");
  await expect(editor).toContainText("Existing Claude conversation");
  await page.getByRole("button", { name: "Add test attachment" }).click();
  await expect(editor).toContainText("provider-switch.txt");
  await provider.click();
  await expect(gui.getByRole("menuitemradio")).toHaveCount(2);
  await gui.getByRole("menuitemradio", { name: "Claude Code", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-selected-provider", "local:claude");
  await expect(provider).toContainText("Claude Code");
  await expect(editor).toContainText("LOCAL_DRAFT_MUST_SURVIVE_PROVIDER_SWITCH");
  await expect(project).toHaveText("Project alpha");
  await expect(editor).toContainText("Existing Claude conversation");
  await expect(editor).toContainText("provider-switch.txt");
  await editor.press("End");
  await editor.pressSequentially(" EDITED_AFTER_PROVIDER_SWITCH");
  await provider.click();
  await gui.getByRole("menuitemradio", { name: "Codex", exact: true }).click();
  await expect(provider).toContainText("Codex");
  await expect(project).toHaveText("Project alpha");
  await expect(editor).toContainText("EDITED_AFTER_PROVIDER_SWITCH");
  await expect(editor).toContainText("provider-switch.txt");
  await provider.click();
  await gui.getByRole("menuitemradio", { name: "Claude Code", exact: true }).click();
  await expect(provider).toContainText("Claude Code");
  await expect(editor).toContainText("EDITED_AFTER_PROVIDER_SWITCH");
  await mkdir(".tmp/local-conversations", { recursive: true });
  await page.screenshot({ path: ".tmp/local-conversations/06-local-provider-switch.png" });
  await page.getByRole("button", { name: "Open original Codex conversation" }).click();
  await expect(provider).toContainText("Codex");
  await expect(editor).toContainText("LOCAL_DRAFT_MUST_SURVIVE_PROVIDER_SWITCH");
  await expect(editor).not.toContainText("EDITED_AFTER_PROVIDER_SWITCH");
  const references = gui.getByTestId("agent-gui-mention-palette-surface");
  await editor.fill("");
  await gui.getByTestId("agent-gui-composer-mention-trigger").click();
  await expect(editor).toContainText("@");
  await expect(references).toBeVisible();
  await editor.press("Escape");
  await expect(references).not.toBeVisible();
  await editor.press("ControlOrMeta+A");
  await editor.press("Backspace");
  await expect(editor).toBeEmpty();
  await editor.pressSequentially("@");
  await expect(references).toBeVisible();
  await editor.press("Escape");
  await page.getByRole("button", { name: "Open existing Claude conversation" }).click();
  await expect(provider).toContainText("Claude Code");
  await page.getByRole("button", { name: "Open original Codex conversation" }).click();
  await expect(editor).toContainText("@");
  await expect(references).not.toBeVisible();
  await editor.pressSequentially(" @");
  await expect(references).toBeVisible();
  await editor.press("Escape");
  await page.getByRole("button", { name: "Open existing Claude conversation" }).click();
  await expect(provider).toContainText("Claude Code");
  await page.getByRole("button", { name: "Open original Codex conversation" }).click();
  await expect(provider).toContainText("Codex");
  await expect(references).not.toBeVisible();
  await gui.getByTestId("agent-gui-composer-mention-trigger").click();
  await expect(references).toBeVisible();
  await gui.getByRole("option").filter({ hasText: "Existing Claude conversation" }).click();
  await expect(editor).toContainText("Existing Claude conversation");
  await editor.press("Escape");
  await editor.fill("LOCAL_DRAFT_MUST_SURVIVE_PROVIDER_SWITCH");
  // The catalog loads lazily after remount; the saved model ID is displayed
  // until the menu resolves its friendly name again.
  await expect(model).toContainText(/test[- ]model/i);
  await model.click();
  await expect(gui.getByRole("menuitemradio", { name: "Test model", exact: true })).toHaveAttribute("aria-checked", "true");
  await editor.press("Escape");
  await expect(model).toContainText("Test model");
  await page.screenshot({ path: ".tmp/local-conversations/07-restored-local-draft.png" });
  await page.getByRole("button", { name: "Open existing Claude conversation" }).click();
  await expect(provider).toContainText("Claude Code");
  await expect(usage).toContainText("left 78%");
  await editor.fill("@");
  await editor.press("Escape");
  await page.getByRole("button", { name: "Open original Codex conversation" }).click();
  await expect(provider).toContainText("Codex");
  await page.getByRole("button", { name: "Open existing Claude conversation" }).click();
  await expect(provider).toContainText("Claude Code");
  await expect(editor).toContainText("@");
  await expect(references).not.toBeVisible();
  await gui.getByTestId("agent-gui-composer-mention-trigger").click();
  await expect(references).toBeVisible();
  await editor.press("Escape");
  await editor.fill("");
  await page.getByRole("button", { name: "Open original Codex conversation" }).click();
  await expect(provider).toContainText("Codex");
  await expect(editor).toContainText("LOCAL_DRAFT_MUST_SURVIVE_PROVIDER_SWITCH");
  expect(await page.locator("body").getAttribute("data-wrong-usage-provider")).toBeNull();
  expect(await page.locator("body").getAttribute("data-unexpected-request")).toBeNull();
  expect(apiRequests).toBe(0);
  await page.getByRole("button", { name: "Open delayed conversation", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-delayed-read", "pending");
  await editor.evaluate(() => new Promise<void>((resolve) => {
    let frames = 0;
    const next = () => { if (++frames === 10) resolve(); else requestAnimationFrame(next); };
    requestAnimationFrame(next);
  }));
  await expect(page.locator("body")).toHaveAttribute("data-selected-session", "delayed-claude");
  await page.getByRole("button", { name: "Open original Codex conversation" }).click();
  await expect(provider).toContainText("Codex");
  await page.evaluate(() => window.dispatchEvent(new Event("release-delayed-session")));
  await editor.evaluate(() => new Promise<void>((resolve) => {
    let frames = 0;
    const next = () => { if (++frames === 10) resolve(); else requestAnimationFrame(next); };
    requestAnimationFrame(next);
  }));
  await expect(gui.getByText(`Saved reply for ${session.id}`, { exact: true })).toBeVisible();
  await expect(provider).toContainText("Codex");
  await expect(page.locator("body")).toHaveAttribute("data-selected-session", session.id);
});
