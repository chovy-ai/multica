import "./env";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { AgentGuiInitSnapshot } from "../packages/tutti-agent-gui-host/src/protocol";
import type { AgentTask, Attachment, ChatMessage } from "../packages/core/types";

const pastedText = `${"甲\r\n".repeat(1000)}LAST_LINE_MUST_REACH_AGENT`;
const normalizedText = pastedText.replaceAll("\r\n", "\n");

async function paste(editor: Locator, text: string) {
  await editor.focus();
  await editor.evaluate((element, value) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", value);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  }, text);
}

async function mount(page: Page, provider: "codex" | "claude", rejectUpload = false) {
  await page.route("**/__test/large-text-paste", (route) => route.fulfill({ contentType: "text/html", body: '<iframe title="Paste test" style="display:block;width:100%;height:850px;border:0"></iframe>' }));
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto("/__test/large-text-paste");
  await page.evaluate(({ provider, rejectUpload }) => {
    const frame = document.querySelector("iframe")!;
    const at = new Date().toISOString();
    const session = { id: "paste-session", workspace_id: "paste-workspace", creator_id: "paste-user", agent_id: `local:${provider}`, title: "Paste", status: "active" as const, created_at: at, updated_at: at, has_unread: false };
    const snapshot: AgentGuiInitSnapshot = { workspaceId: session.workspace_id, workspaceSlug: "paste-test", userId: session.creator_id, locale: "en", theme: provider === "codex" ? "light" : "dark", local: true, sidePane: provider === "claude", hostActive: true, hostVisible: true, agents: [], sessions: [session], activeSessionId: session.id, selectedAgentId: session.agent_id,
      executionTargets: [{ id: session.agent_id, provider, name: provider === "codex" ? "Codex" : "Claude Code", iconUrl: "", canInvoke: true, runtimeBound: true, runtimeOnline: true }] };
    const files: { attachment: Attachment; text: string }[] = [];
    const messages: ChatMessage[] = [];
    const tasks: AgentTask[] = [];
    const storage = new Map<string, string>();
    let uploadAttempts = 0;
    window.addEventListener("message", (event) => {
      if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== "multica:agent-gui:ready") return;
      const channel = new MessageChannel();
      channel.port1.onmessage = async (event) => {
        const request = event.data;
        if (request.type !== "request") return;
        let result: unknown;
        switch (request.method) {
          case "workspace.load": result = { ...snapshot, pendingTasks: tasks.map((task) => ({ task_id: task.id, status: task.status, chat_session_id: session.id })) }; break;
          case "session.load": result = { session, messages, tasks, pending: tasks[0] ? { task_id: tasks[0].id, status: "running", created_at: at } : {} }; break;
          case "attachment.upload": {
            if (rejectUpload && ++uploadAttempts === 1) {
              channel.port1.postMessage({ type: "response", id: request.id, error: { message: "Test upload failed", status: 400 } }); return;
            }
            const file: File = request.params.file;
            const id = `paste-${files.length + 1}`;
            const attachment = { id, filename: file.name, content_type: file.type, size_bytes: file.size, markdown_url: `/attachments/${id}/download`, url: `/attachments/${id}/download` } as Attachment;
            files.push({ attachment, text: await file.text() });
            document.body.dataset.files = JSON.stringify(files);
            result = attachment; break;
          }
          case "attachment.read": {
            const file = files.find((file) => file.attachment.id === request.params.attachmentId)!;
            const bytes = new TextEncoder().encode(file.text);
            result = { name: file.attachment.filename, mimeType: "text/plain", data: btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")) }; break;
          }
          case "session.send": {
            document.body.dataset.sent = JSON.stringify(request.params);
            tasks.push({ id: "paste-turn", chat_session_id: session.id, status: "running", created_at: at, started_at: at } as AgentTask);
            messages.push({ id: "paste-message", chat_session_id: session.id, role: "user", content: request.params.content, task_id: "paste-turn", created_at: at, attachments: files.filter((file) => request.params.attachmentIds?.includes(file.attachment.id)).map((file) => file.attachment) } as ChatMessage);
            result = { message_id: "paste-message", task_id: "paste-turn", created_at: at }; break;
          }
          case "storage.read": result = storage.get(request.params.key) ?? null; break;
          case "storage.write": storage.set(request.params.key, request.params.value); break;
          case "task.messages": case "context.tasks": result = []; break;
          case "models.list": result = { id: "paste-models", status: "completed", supported: true, models: [] }; break;
          case "usage.read": result = { provider, context: { usedTokens: null, limitTokens: null, model: null, updatedAt: null }, account: { status: "unavailable", windows: [], updatedAt: null } }; break;
          case "session.watch": case "session.markRead": case "host.selectSession": case "host.promptApplied": break;
          default: document.body.dataset.failure = `Unexpected ${request.method}`; channel.port1.postMessage({ type: "response", id: request.id, error: { message: document.body.dataset.failure } }); return;
        }
        channel.port1.postMessage({ type: "response", id: request.id, result });
      };
      channel.port1.start();
      frame.contentWindow!.postMessage({ type: "multica:agent-gui:connect", snapshot }, location.origin, [channel.port2]);
    });
    frame.src = "/tutti-agent-gui/index.html";
  }, { provider, rejectUpload });
  const gui = page.frameLocator("iframe");
  const editor = gui.getByTestId("agent-gui-composer-editor");
  await expect(editor).toBeVisible();
  return { gui, editor, chip: gui.getByTestId("agent-gui-composer-large-text-draft"), send: gui.getByTestId("agent-gui-composer-send") };
}

for (const provider of ["codex", "claude"] as const) test(`${provider} folds more than 1000 short lines and sends the entire text attachment`, async ({ page }) => {
  const { gui, editor, chip, send } = await mount(page, provider);
  await editor.pressSequentially("Read the full pasted text.");
  await paste(editor, pastedText);
  await expect(chip).toBeVisible();
  await expect(chip).not.toHaveAttribute("data-uploading");
  await expect(editor).toHaveText("Read the full pasted text.");
  await expect(send).toBeEnabled();
  await expect.poll(() => chip.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const area = element.closest(".agent-gui-node__composer-prompt-input-area, .agent-gui-node__composer-hero-prompt-input-area")!.getBoundingClientRect();
    return bounds.top >= area.top && bounds.bottom <= area.bottom;
  })).toBe(true);
  expect((await chip.boundingBox())!.height).toBeLessThan(90);
  await page.screenshot({ path: `.tmp/large-text-paste/${provider}-draft.png`, animations: "disabled" });
  await send.click();
  await expect(gui.getByTestId("agent-gui-composer-stop-active-turn")).toBeVisible();
  const sent = await page.locator("body").evaluate((body) => JSON.parse(body.dataset.sent!));
  const files = await page.locator("body").evaluate((body) => JSON.parse(body.dataset.files!));
  expect(sent.attachmentIds).toEqual([files.at(-1).attachment.id]);
  expect(sent.content).toContain("Read the full pasted text.");
  expect(files.at(-1).text).toBe(normalizedText);
  expect(files.at(-1).attachment.content_type).toBe("text/plain");
  expect(files.at(-1).attachment.size_bytes).toBe(Buffer.byteLength(normalizedText));
  await expect(page.locator("body")).not.toHaveAttribute("data-failure");
});

for (const failed of [false, true]) test(`a ${failed ? "failed" : "saved"} large paste can be restored without losing any lines`, async ({ page }) => {
  const { editor, chip, send } = await mount(page, "codex", failed);
  await paste(editor, pastedText);
  await expect(chip).toBeVisible();
  await expect(chip).not.toHaveAttribute("data-uploading");
  if (failed) {
    await expect(chip).toHaveAttribute("data-upload-error", "true");
    await expect(send).toBeDisabled();
  } else await expect(send).toBeEnabled();
  await chip.getByRole("button", { name: "Show in text field", exact: true }).click();
  expect(await editor.innerText()).toBe(normalizedText);
  await expect(chip).toHaveCount(0);
  await expect(send).toBeEnabled();
  await expect(page.locator("body")).not.toHaveAttribute("data-sent");
});
