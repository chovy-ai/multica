import "./env";
import { expect, test } from "@playwright/test";
import type { AgentGuiInitSnapshot } from "../packages/tutti-agent-gui-host/src/protocol";

for (const provider of ["codex", "claude"] as const) for (const imageOnly of [false, true]) {
  test(`${provider} copies ${imageOnly ? "image-only" : "mixed"} messages as addresses across local sessions`, async ({ page }) => {
    await page.route("**/__test/message-image-copy", (route) => route.fulfill({ contentType: "text/html", body: '<iframe title="Image copy test" style="width:100%;height:850px;border:0"></iframe>' }));
    await page.goto("/__test/message-image-copy");
    await page.evaluate(({ provider, imageOnly }) => {
      const frame = document.querySelector("iframe")!;
      const at = new Date().toISOString();
      const source = { id: "source", workspace_id: "copy-workspace", creator_id: "copy-user", agent_id: `local:${provider}`, title: "Source images", status: "active" as const, created_at: at, updated_at: at, has_unread: false };
      const destination = { ...source, id: "destination", title: "Destination images" };
      const snapshot: AgentGuiInitSnapshot = {
        workspaceId: source.workspace_id, workspaceSlug: "test", userId: source.creator_id, locale: "en", theme: "dark", local: true,
        hostActive: true, hostVisible: true, agents: [], sessions: [source, destination], activeSessionId: source.id, selectedAgentId: source.agent_id,
        executionTargets: [{ id: source.agent_id, provider, name: provider === "codex" ? "Codex" : "Claude Code", iconUrl: "", canInvoke: true, runtimeBound: true, runtimeOnline: true }],
      };
      const pixels = ["#ff0000", "#0000ff"].map((color) => {
        const canvas = document.createElement("canvas"); canvas.width = 16; canvas.height = 16;
        const context = canvas.getContext("2d")!; context.fillStyle = color; context.fillRect(0, 0, 16, 16);
        return canvas.toDataURL("image/png").split(",")[1]!;
      });
      const files = pixels.map((data, index) => ({ id: `image-${index}`, filename: `screen-${index}.png`, content_type: "image/png", size_bytes: data.length,
        url: `file:///private/multica/files/image-${index}`, markdown_url: `file:///private/multica/files/image-${index}` }));
      const sourceMessage = { id: "original", chat_session_id: source.id, role: "user", content: imageOnly ? "[Image attachment: screen-0.png]\n\n[Image attachment: screen-1.png]" : "Keep both images", attachments: files, created_at: at };
      const sends: Record<string, unknown>[] = [];
      let port: MessagePort;
      let failReads = false;
      window.addEventListener("test-copy-destination", () => port.postMessage({ type: "event", event: { type: "init", snapshot: { ...snapshot, activeSessionId: destination.id } } }));
      window.addEventListener("test-copy-fail-read", () => { failReads = true; });
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== "multica:agent-gui:ready") return;
        const channel = new MessageChannel(); port = channel.port1;
        port.onmessage = (event) => {
          const request = event.data;
          if (request.type !== "request") return;
          let result: unknown;
          switch (request.method) {
            case "workspace.load": result = snapshot; break;
            case "session.load": result = { session: request.params.sessionId === source.id ? source : destination,
              messages: request.params.sessionId === source.id ? [sourceMessage] : sends.map((send, index) => ({ id: `copied-${index}`, chat_session_id: destination.id,
                role: "user", content: send.content, attachments: files.filter((file) => (send.attachmentIds as string[]).includes(file.id)), created_at: at })), tasks: sends.map((_send, index) => ({ id: `turn-${index}`, chat_session_id: destination.id, status: "completed", created_at: at, completed_at: at })), pending: {} }; break;
            case "attachment.read": {
              if (failReads) { port.postMessage({ type: "response", id: request.id, error: { message: "Referenced image no longer exists" } }); return; }
              const index = files.findIndex((file) => file.id === request.params.attachmentId);
              result = { data: pixels[index], name: files[index]!.filename, mimeType: "image/png" }; break;
            }
            case "session.send": sends.push(request.params); document.body.dataset.sends = JSON.stringify(sends);
              result = { message_id: `copied-${sends.length - 1}`, task_id: `turn-${sends.length - 1}`, created_at: at }; break;
            case "storage.read": result = null; break;
            case "host.showMessage": document.body.dataset.lastMessage = request.params.message; break;
            case "storage.write": case "session.watch": case "session.markRead": case "host.selectSession": break;
            case "context.tasks": case "task.messages": result = []; break;
            case "models.list": result = { id: "models", status: "completed", supported: true, models: [] }; break;
            case "usage.read": result = { provider, context: { usedTokens: null, limitTokens: null, model: null, updatedAt: null }, account: { status: "unavailable", plan: null, windows: [], updatedAt: null } }; break;
            default: document.body.dataset.failure = request.method; port.postMessage({ type: "response", id: request.id, error: { message: `Unexpected ${request.method}` } }); return;
          }
          port.postMessage({ type: "response", id: request.id, result });
        };
        port.start();
        frame.contentWindow!.postMessage({ type: "multica:agent-gui:connect", snapshot }, location.origin, [channel.port2]);
      });
      frame.src = "/tutti-agent-gui/index.html";
    }, { provider, imageOnly });
    const gui = page.frameLocator("iframe");
    const editor = gui.getByTestId("agent-gui-composer-editor");
    await expect(editor).toBeVisible();
    await expect(gui.getByRole("img", { name: /^screen-/ })).toHaveCount(2);
    const originalSources = await gui.getByRole("img", { name: /^screen-/ }).evaluateAll((images) => images.map((image) => image.getAttribute("src")));
    await editor.evaluate((element) => {
      Object.defineProperty(element.ownerDocument.defaultView!.navigator, "clipboard", { configurable: true,
        value: { writeText: async (text: string) => { element.ownerDocument.documentElement.dataset.copied = text; } } });
    });
    const copyButton = gui.getByRole("button", { name: "Copy message", exact: true });
    await copyButton.focus();
    await copyButton.press("Enter");
    const copied = await editor.evaluate((element) => element.ownerDocument.documentElement.dataset.copied!);
    expect(copied).toContain("multica-image://attachment/copy-workspace/image-0");
    expect(copied).toContain("multica-image://attachment/copy-workspace/image-1");
    expect(copied).not.toContain("base64");
    expect(copied.length).toBeLessThan(600);
    await page.evaluate(() => window.dispatchEvent(new Event("test-copy-destination")));
    await expect(gui.locator('[data-agent-session-id="destination"]')).toBeVisible();
    await expect(gui.getByRole("button", { name: "Copy message", exact: true })).toHaveCount(0);
    const paste = () => editor.evaluate((element, text) => {
      const data = new DataTransfer(); data.setData("text/plain", text);
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    }, copied);
    await paste();
    const drafts = gui.getByTestId("agent-gui-composer-image-draft");
    await expect(drafts).toHaveCount(2);
    await expect(editor).toHaveText(imageOnly ? "" : "Keep both images");
    for (const draft of await drafts.all()) {
      await expect(draft).not.toHaveAttribute("data-uploading", "true");
      await expect.poll(() => draft.locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 16)).toBe(true);
    }
    expect(await drafts.locator("img").evaluateAll((images) => images.map((image) => image.getAttribute("src")))).toEqual(originalSources);
    if (provider === "codex" && !imageOnly) await page.screenshot({ path: "test-results/chov24-copy-preview.png" });
    await gui.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => page.locator("body").getAttribute("data-sends")).not.toBeNull();
    const sends = JSON.parse((await page.locator("body").getAttribute("data-sends"))!);
    expect(sends[0].sessionId).toBe("destination");
    expect(sends[0].attachmentIds).toEqual(["image-0", "image-1"]);
    expect(sends[0].content).not.toContain("multica-image:");
    if (!imageOnly) expect(sends[0].content).toContain("Keep both images");
    await expect(drafts).toHaveCount(0);
    await paste(); await paste();
    await expect(drafts).toHaveCount(4);
    await expect(page.locator("body")).not.toHaveAttribute("data-failure");
    await page.evaluate(() => window.dispatchEvent(new Event("test-copy-fail-read")));
    await paste();
    await expect(gui.locator('[data-testid="agent-gui-composer-image-draft"][data-upload-error="true"]')).toHaveCount(2);
    await expect(page.locator("body")).toHaveAttribute("data-last-message", "Image failed to load");
    await expect(gui.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    if (provider === "codex" && !imageOnly) await page.screenshot({ path: "test-results/chov24-copy-read-failure.png" });
  });
}
