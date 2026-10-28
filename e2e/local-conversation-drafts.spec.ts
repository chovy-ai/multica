import "./env";
import { expect, test, type Page } from "@playwright/test";
import type { AgentGuiInitSnapshot, AgentGuiSession } from "../packages/tutti-agent-gui-host/src/protocol";

async function mountDraftHarness(page: Page, desktopQueue: boolean, holdAdmission = false) {
  const at = "2026-10-28T00:00:00Z";
  const sessions = ["a", "b"].map((id) => ({ id, workspace_id: "draft-workspace", creator_id: "draft-user", agent_id: "local:codex",
    title: `Conversation ${id}`, status: "active", created_at: at, updated_at: at, has_unread: false } as AgentGuiSession));
  const snapshot: AgentGuiInitSnapshot = {
    workspaceId: "draft-workspace", workspaceSlug: "test", userId: "draft-user", locale: "en", theme: "light",
    local: true, composerDraftScope: JSON.stringify(["https://api.example.test", ""]),
    ...(desktopQueue ? { queueOwner: "desktop" as const } : {}),
    hostActive: true, hostVisible: true, agents: [], sessions, activeSessionId: "a", selectedAgentId: "local:codex",
    executionTargets: [{ id: "local:codex", provider: "codex", name: "Codex", iconUrl: "", canInvoke: true, runtimeBound: true, runtimeOnline: true }],
  };
  await page.route("**/__test/conversation-drafts", (route) => route.fulfill({ contentType: "text/html", body: '<button id="away">Other tab</button><button id="back">Conversation tab</button><button id="a">Open A</button><button id="b">Open B</button><button id="accept">Accept pending</button><div id="content"></div>' }));
  await page.setViewportSize({ width: 1280, height: 950 });
  await page.goto("/__test/conversation-drafts");
  await page.evaluate(({ snapshot, at, holdAdmission }) => {
    const storage = new Map<string, string>();
    let frame: HTMLIFrameElement | null = null;
    let port: MessagePort | null = null;
    let sends = 0;
    const sent = new Map<string, string>();
    const accepted = new Set<string>();
    let completeAdmission: (() => void) | null = null;
    document.querySelector("#accept")!.addEventListener("click", () => { completeAdmission?.(); completeAdmission = null; });
    const publishSelection = (id: string) => {
      snapshot.activeSessionId = id;
      port?.postMessage({ type: "event", event: { type: "init", snapshot } });
    };
    document.querySelector("#a")!.addEventListener("click", () => publishSelection("a"));
    document.querySelector("#b")!.addEventListener("click", () => publishSelection("b"));
    document.querySelector("#away")!.addEventListener("click", () => {
      frame?.remove(); frame = null; port?.close(); port = null;
    });
    const mount = () => {
      if (frame) throw new Error("Expected the previous GUI document to be destroyed");
      frame = document.createElement("iframe"); frame.title = "Draft test";
      frame.style.cssText = "display:block;width:100%;height:850px;border:0";
      frame.src = `/tutti-agent-gui/index.html?connection=${crypto.randomUUID()}`;
      document.querySelector("#content")!.append(frame);
    };
    document.querySelector("#back")!.addEventListener("click", mount);
    window.addEventListener("message", (event) => {
      if (!frame || event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== "multica:agent-gui:ready") return;
      const channel = new MessageChannel();
      const responsePort = channel.port1; port = responsePort;
      port.onmessage = (event) => {
        const request = event.data;
        if (request.type !== "request") return;
        let result: unknown;
        switch (request.method) {
          case "workspace.load": result = snapshot; break;
          case "session.load": {
            const session = snapshot.sessions.find((entry) => entry.id === request.params.sessionId)!;
            result = { session, messages: [{ id: `reply-${session.id}`, chat_session_id: session.id, role: "assistant", content: sent.get(session.id) ?? `Saved reply ${session.id}`, task_id: null, created_at: at }],
              tasks: [], pending: {}, ...(snapshot.queueOwner ? { promptQueue: { revision: sends, paused: false, items: [] } } : {}) };
            break;
          }
          case "queue.enqueue":
          case "session.send": {
            sends++; document.body.dataset.sends = String(sends);
            const text = request.params.item?.content ?? request.params.content;
            document.body.dataset.submitIds = JSON.stringify([...(JSON.parse(document.body.dataset.submitIds ?? "[]")), request.params.item?.requestId ?? request.params.clientSubmitId]);
            if (text === "FAIL_THIS_SEND" && sends === 1) {
              responsePort.postMessage({ type: "response", id: request.id, error: { message: "Test send rejected", code: "test_rejected", status: 400 } }); return;
            }
            const accept = () => {
              sent.set(request.params.sessionId, text);
              accepted.add(request.params.item?.requestId ?? request.id);
              document.body.dataset.accepted = String(accepted.size);
            };
            if (holdAdmission && sends === 1) {
              completeAdmission = () => {
                accept();
                responsePort.postMessage({ type: "response", id: request.id, result: { revision: sends, paused: false, items: [] } });
              };
              return;
            }
            accept();
            result = request.method === "queue.enqueue" ? { revision: sends, paused: false, items: [] }
              : { message_id: `input-${sends}`, task_id: `task-${sends}`, created_at: at };
            break;
          }
          case "storage.read": result = storage.get(request.params.key) ?? null; break;
          case "storage.write": storage.set(request.params.key, request.params.value); break;
          case "models.list": result = { supported: true, models: [] }; break;
          case "usage.read": result = { provider: "codex", context: { usedTokens: null, limitTokens: null, model: null, updatedAt: null }, account: { status: "unavailable", plan: null, windows: [], updatedAt: null } }; break;
          case "task.messages": case "context.tasks": result = []; break;
          case "host.selectSession": snapshot.activeSessionId = request.params.sessionId; break;
          case "host.showMessage": document.body.dataset.notice = request.params.message; break;
          case "session.watch": case "session.markRead": case "host.promptApplied": break;
          default: document.body.dataset.unexpected = request.method;
            responsePort.postMessage({ type: "response", id: request.id, error: { message: `Unexpected request: ${request.method}` } }); return;
        }
        responsePort.postMessage({ type: "response", id: request.id, result });
      };
      port.start();
      frame.contentWindow!.postMessage({ type: "multica:agent-gui:connect", snapshot }, location.origin, [channel.port2]);
    });
    document.body.dataset.sends = "0";
    mount();
  }, { snapshot, at, holdAdmission });
}

test("preserves per-conversation multiline drafts across real GUI document destruction", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mountDraftHarness(page, true);
  const gui = page.frameLocator("iframe");
  const editor = gui.getByTestId("agent-gui-composer-editor");
  await expect(editor).toBeVisible({ timeout: 30_000 });
  const multiline = "A first line\nA second line";
  await editor.fill(multiline);
  await page.getByRole("button", { name: "Open B", exact: true }).click();
  await expect(editor).toBeEmpty();
  await editor.fill("B independent draft");
  const remount = async () => {
    await page.getByRole("button", { name: "Other tab", exact: true }).click();
    await expect(page.locator("iframe")).toHaveCount(0);
    await page.getByRole("button", { name: "Conversation tab", exact: true }).click();
    await expect(editor).toBeVisible({ timeout: 30_000 });
  };
  for (let round = 0; round < 2; round++) {
    await remount();
    await expect(editor).toHaveText("B independent draft");
    await page.getByRole("button", { name: "Open A", exact: true }).click();
    await expect.poll(() => editor.innerText()).toBe(multiline);
    await page.getByRole("button", { name: "Open B", exact: true }).click();
    await expect(editor).toHaveText("B independent draft");
  }
  await expect(page.locator("body")).toHaveAttribute("data-sends", "0");
  await editor.fill("");
  await remount();
  await expect(editor).toBeEmpty();
  await page.getByRole("button", { name: "Open A", exact: true }).click();
  await expect.poll(() => editor.innerText()).toBe(multiline);
  await editor.fill("New text after restoration");
  await remount();
  await expect(editor).toHaveText("New text after restoration");
  await gui.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-sends", "1");
  await expect(editor).toBeEmpty();
  await remount();
  await expect(editor).toBeEmpty();
  await expect(page.locator("body")).toHaveAttribute("data-sends", "1");
  expect(await page.locator("body").getAttribute("data-unexpected")).toBeNull();
  expect(errors).toEqual([]);
});

for (const desktopQueue of [false, true]) {
  test(`retains a rejected ${desktopQueue ? "desktop admission" : "send"} after returning to the conversation tab`, async ({ page }) => {
    await mountDraftHarness(page, desktopQueue);
    const gui = page.frameLocator("iframe");
    const editor = gui.getByTestId("agent-gui-composer-editor");
    await expect(editor).toBeVisible({ timeout: 30_000 });
    await editor.fill("FAIL_THIS_SEND");
    await gui.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator("body")).toHaveAttribute("data-sends", "1");
    if (desktopQueue) await expect(gui.getByRole("alert")).toContainText("Test send rejected");
    else await expect(editor).toHaveText("FAIL_THIS_SEND");
    await page.getByRole("button", { name: "Other tab", exact: true }).click();
    await expect(page.locator("iframe")).toHaveCount(0);
    await page.getByRole("button", { name: "Conversation tab", exact: true }).click();
    await expect(gui.locator("body")).toContainText("FAIL_THIS_SEND", { timeout: 5_000 });
    await expect(page.locator("body")).toHaveAttribute("data-sends", "1");
    if (desktopQueue) {
      await gui.getByRole("button", { name: "Send next", exact: true }).click();
      await expect(page.locator("body")).toHaveAttribute("data-sends", "2");
      const ids: string[] = JSON.parse((await page.locator("body").getAttribute("data-submit-ids"))!);
      expect(ids[1]).toBe(ids[0]);
      await expect(gui.getByRole("button", { name: "Send next", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Other tab", exact: true }).click();
      await page.getByRole("button", { name: "Conversation tab", exact: true }).click();
      await expect(editor).toBeVisible({ timeout: 30_000 });
      await expect(editor).toBeEmpty();
      await expect(gui.getByRole("button", { name: "Send next", exact: true })).toHaveCount(0);
      await expect(page.locator("body")).toHaveAttribute("data-sends", "2");
    }
  });
}

test("keeps an in-flight desktop admission across tab destruction without replaying an uncertain send", async ({ page }) => {
  await mountDraftHarness(page, true, true);
  const gui = page.frameLocator("iframe");
  const editor = gui.getByTestId("agent-gui-composer-editor");
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await editor.fill("Awaiting admission");
  await gui.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-sends", "1");
  await page.getByRole("button", { name: "Other tab", exact: true }).click();
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.getByRole("button", { name: "Conversation tab", exact: true }).click();
  await expect(gui.locator('[data-testid^="agent-gui-composer-queued-prompt-"]')).toContainText("Awaiting admission");
  await expect(page.locator("body")).toHaveAttribute("data-sends", "1");
  await page.getByRole("button", { name: "Accept pending", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-accepted", "1");
  await gui.getByRole("button", { name: "Send next", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-sends", "2");
  const ids: string[] = JSON.parse((await page.locator("body").getAttribute("data-submit-ids"))!);
  expect(ids[1]).toBe(ids[0]);
  await expect(page.locator("body")).toHaveAttribute("data-accepted", "1");
  await expect(gui.locator('[data-testid^="agent-gui-composer-queued-prompt-"]')).toHaveCount(0);
});
