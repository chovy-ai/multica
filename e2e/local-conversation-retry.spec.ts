import "./env";
import { expect, test } from "@playwright/test";
import type { AgentGuiInitSnapshot, AgentGuiSession } from "../packages/tutti-agent-gui-host/src/protocol";

// This host exercises the built GUI and daemon RPC contract without a real model.
export function installRetryFixture({ theme, locale }: { theme: "light" | "dark"; locale: "en" | "zh-CN" }) {
  const at = "2026-11-03T08:00:00Z";
  const frame = document.querySelector("iframe")!;
  const session = { id: "retry-session", workspace_id: "retry-workspace", creator_id: "retry-user", agent_id: "local:codex", title: "Model capacity recovery", status: "active", created_at: at, updated_at: at, has_unread: false } as AgentGuiSession;
  const initial: AgentGuiInitSnapshot = {
    workspaceId: session.workspace_id, workspaceSlug: "test", userId: session.creator_id, locale, theme, local: true, queueOwner: "desktop",
    hostActive: true, hostVisible: true, agents: [], sessions: [session], activeSessionId: session.id, selectedAgentId: session.agent_id,
    executionTargets: [{ id: session.agent_id, provider: "codex", name: "Codex", iconUrl: "", canInvoke: true, runtimeBound: true, runtimeOnline: true }],
  };
  let port: MessagePort;
  let state = "failed";
  let submissions = 0;
  let queue = { revision: 0, paused: false, items: [] as unknown[] };
  const storage = new Map<string, string>();
  const error = { kind: "provider_error", message: "Selected model is at capacity. Please try a different model." };
  window.addEventListener("retry-fixture-state", (event) => {
    state = (event as CustomEvent<string>).detail;
    session.status = state === "archived" ? "archived" : "active";
    queue = { revision: queue.revision + 1, paused: state === "queued", items: state === "queued" ? [{ requestId: "queued-request", content: "Pending prompt", display: { id: "queued-request", clientSubmitId: "queued-request", content: [{ type: "text", text: "Pending prompt" }], createdAtUnixMs: Date.now() } }] : [] };
    port.postMessage({ type: "event", event: { type: "local.reload", sessionId: session.id } });
  });
  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== "multica:agent-gui:ready") return;
    const channel = new MessageChannel(); port = channel.port1;
    port.onmessage = ({ data: request }) => {
      if (request.type !== "request") return;
      let result: unknown;
      switch (request.method) {
        case "workspace.load": result = initial; break;
        case "storage.read": result = storage.get(request.params.key) ?? null; break;
        case "storage.write": storage.set(request.params.key, request.params.value); break;
        case "context.tasks": result = []; break;
        case "models.list": result = { supported: true, models: [{ id: "test-model", label: "Test model", isDefault: true }] }; break;
        case "usage.read": result = { provider: "codex", context: { usedTokens: null, limitTokens: null, model: null, updatedAt: null }, account: { status: "unavailable", plan: null, windows: [], updatedAt: null } }; break;
        case "local.snapshot": {
          document.body.dataset.loadedState = state;
          const failed = { id: "failed-turn", turn_index: 0, request_id: "failed-request", status: "failed", started_at: at, completed_at: at, error,
            messages: [{ id: "user-1", role: "user", content: "Continue checking the project", attachment_ids: [], created_at: at }],
            events: [{ seq: 1, turn_id: "failed-turn", turn_seq: 1, item_id: "answer-1", type: "item.completed", final: true, created_at: at, payload: { kind: "assistant_text", status: "completed", text: "I will inspect the project before making changes." } }] };
          const newer = state === "running" || state === "completed";
          result = { detail: { session: { ...session }, messages: [], tasks: [], pending: {}, promptQueue: queue },
            snapshot: { version: 2, store_generation: "retry-fixture", snapshot_seq: 1, has_older_turns: false, pending_interactions: [],
              conversation: { conversation_id: session.id, summary_seq: 1, provider: "codex", title: session.title, status: state === "running" ? "running" : "idle", pinned: false, archived: state === "archived", updated_at: at },
              turns: [failed, ...(newer ? [{ id: "newer-turn", turn_index: 1, request_id: "new-request", status: state, started_at: "2026-11-03T09:00:00Z", messages: [], events: [] }] : [])] } };
          break;
        }
        case "queue.enqueue":
          document.body.dataset.submissions = String(++submissions);
          document.body.dataset.submitted = JSON.stringify(request.params);
          queue = { revision: queue.revision + 1, paused: false, items: [request.params.item] };
          result = queue;
          break;
        case "local.subscribe": case "local.unsubscribe": case "session.watch": case "session.markRead": case "host.selectSession": case "host.promptApplied": break;
        default: document.body.dataset.unexpectedRequest = request.method;
      }
      port.postMessage({ type: "response", id: request.id, result });
    };
    port.start();
    frame.contentWindow!.postMessage({ type: "multica:agent-gui:connect", snapshot: initial }, location.origin, [channel.port2]);
  });
  frame.src = "/tutti-agent-gui/index.html";
}

for (const [theme, locale] of [["light", "en"], ["dark", "zh-CN"]] as const) test(`retries a failed local turn in ${theme} without clearing the draft or dispatching twice`, async ({ page }) => {
  await page.route("**/__test/conversation-retry", (route) => route.fulfill({ contentType: "text/html", body: '<style>html,body{margin:0;height:100%}iframe{display:block;width:100%;height:100%;border:0}</style><iframe title="Conversation retry"></iframe>' }));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/__test/conversation-retry");
  await page.evaluate(installRetryFixture, { theme, locale });
  const gui = page.frameLocator("iframe");
  const retry = gui.getByRole("button", { name: locale === "en" ? "Retry" : "重试", exact: true });
  const editor = gui.getByTestId("agent-gui-composer-editor");
  await expect(retry).toBeVisible();
  await editor.fill("Keep this unsent draft");
  await retry.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(page.locator("body")).toHaveAttribute("data-submissions", "1");
  const submitted = JSON.parse((await page.locator("body").getAttribute("data-submitted"))!);
  expect(submitted).toMatchObject({ sessionId: "retry-session", item: { content: locale === "en" ? "Continue" : "继续" } });
  expect(submitted.item.requestId).not.toBe("failed-request");
  await expect(editor).toHaveText("Keep this unsent draft");
  await expect(retry).toHaveCount(0);
  for (const state of ["running", "completed", "archived", "queued"]) {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("retry-fixture-state", { detail: "failed" })));
    await expect(page.locator("body")).toHaveAttribute("data-loaded-state", "failed");
    await expect(retry).toBeVisible();
    await page.evaluate((state) => window.dispatchEvent(new CustomEvent("retry-fixture-state", { detail: state })), state);
    await expect(page.locator("body")).toHaveAttribute("data-loaded-state", state);
    await expect(retry).toHaveCount(0);
    await expect(editor).toHaveText("Keep this unsent draft");
  }
  await expect(page.locator("body")).not.toHaveAttribute("data-unexpected-request");
});
