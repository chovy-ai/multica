import "./env";
import { expect, test } from "@playwright/test";
import type { AgentGuiInitSnapshot } from "../packages/tutti-agent-gui-host/src/protocol";

const png = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGNQzjxBEmIY1TCqYfhqAAAciFQQmuMXLwAAAABJRU5ErkJggg==";

for (const provider of ["codex", "claude"] as const) for (const entry of ["paste", "upload"] as const) test(`${provider} sends ${entry} local images with text and without text`, async ({ page }) => {
  await page.route("**/__test/local-image", (route) => route.fulfill({ contentType: "text/html", body: '<iframe title="Image input test" style="display:block;width:100%;height:850px;border:0"></iframe>' }));
  await page.goto("/__test/local-image");
  await page.evaluate((provider) => {
    const frame = document.querySelector("iframe")!;
    const at = new Date().toISOString();
    const session = { id: "image-session", workspace_id: "image-workspace", creator_id: "image-user", agent_id: `local:${provider}`, title: "Images", status: "active" as const, created_at: at, updated_at: at, has_unread: false };
    const snapshot: AgentGuiInitSnapshot = { workspaceId: session.workspace_id, workspaceSlug: "test", userId: session.creator_id, locale: "en", theme: "dark", local: true, hostActive: true, hostVisible: true, agents: [], sessions: [session], activeSessionId: session.id, selectedAgentId: session.agent_id,
      executionTargets: [{ id: session.agent_id, provider, name: provider === "codex" ? "Codex" : "Claude Code", iconUrl: "", canInvoke: true, runtimeBound: true, runtimeOnline: true }] };
    const files: any[] = [], sends: any[] = [];
    const fileData = new Map<string, string>();
    const availableImages = new Set<string>();
    let port: MessagePort;
    window.addEventListener("test-complete-image", () => {
      const taskId = `turn-${sends.length - 1}`; availableImages.add(taskId);
      port.postMessage({ type: "event", event: { type: "invalidate", scope: "task", sessionId: session.id, taskId } });
    });
    window.addEventListener("message", (event) => {
      if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== "multica:agent-gui:ready") return;
      const channel = new MessageChannel();
      port = channel.port1;
      channel.port1.onmessage = async (event) => {
        const request = event.data;
        if (request.type !== "request") return;
        let result: unknown;
        switch (request.method) {
          case "workspace.load": result = snapshot; break;
          case "session.load": result = { session, messages: sends.flatMap((send, index) => [
            { id: `user-${index}`, chat_session_id: session.id, task_id: `turn-${index}`, role: "user", content: send.content, attachments: files.filter((file) => send.attachmentIds?.includes(file.id)), created_at: at },
            { id: `reply-${index}`, chat_session_id: session.id, task_id: `turn-${index}`, role: "assistant", content: `Test reply ${index + 1}\n\n![Local chart](/fixture-output.png)`, created_at: at },
          ]), tasks: sends.map((_send, index) => ({ id: `turn-${index}`, chat_session_id: session.id, status: "completed", created_at: at, completed_at: at })), pending: {} }; break;
          case "attachment.upload": {
            const file = request.params.file as File;
            const dataUrl = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(file); });
            const id = `image-${files.length + 1}`;
            fileData.set(id, dataUrl.split(",")[1]!);
            const url = `file:///private/multica/files/${id}`;
            result = { id, filename: file.name, content_type: file.type, size_bytes: file.size, url, markdown_url: url, download_url: url, created_at: at };
            files.push(result); document.body.dataset.uploadCount = String(files.length); break;
          }
          case "attachment.read": {
            const file = files.find((file) => file.id === request.params.attachmentId)!;
            result = { data: fileData.get(file.id), name: file.filename, mimeType: file.content_type }; break;
          }
          case "session.send": sends.push(request.params); document.body.dataset.sends = JSON.stringify(sends); result = { message_id: `user-${sends.length - 1}`, task_id: `turn-${sends.length - 1}`, created_at: at }; break;
          case "storage.read": result = localStorage.getItem(request.params.key); break;
          case "storage.write": localStorage.setItem(request.params.key, request.params.value); break;
          case "task.messages": result = availableImages.has(request.params.taskId) ? [{ type: "tool_result", task_id: request.params.taskId, seq: 1, tool: "ImageGeneration", call_id: `image-${request.params.taskId}`, output: JSON.stringify({ savedPath: `/multica-local-images/11111111-1111-4111-8111-111111111111/generated.png`, imageMimeType: "image/png" }), created_at: at }] : []; break;
          case "image.read": result = { data: request.params.path === "/fixture-output.png" ? window.testMarkdownImageBytes : window.testImageBytes, mimeType: "image/png", name: "generated.png" }; break;
          case "context.tasks": result = []; break;
          case "session.watch": case "session.markRead": case "host.selectSession": break;
          case "models.list": result = { id: "models", status: "completed", supported: true, models: [] }; break;
          case "usage.read": result = { provider, context: { usedTokens: null, limitTokens: null, model: null, updatedAt: null }, account: { status: "unavailable", plan: null, windows: [], updatedAt: null } }; break;
          default: document.body.dataset.failure = request.method; channel.port1.postMessage({ type: "response", id: request.id, error: { message: `Unexpected ${request.method}` } }); return;
        }
        channel.port1.postMessage({ type: "response", id: request.id, result });
      };
      channel.port1.start();
      frame.contentWindow!.postMessage({ type: "multica:agent-gui:connect", snapshot }, location.origin, [channel.port2]);
    });
    frame.src = "/tutti-agent-gui/index.html";
  }, provider);
  await page.evaluate(() => {
    const image = (width: number, height: number) => {
      const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d")!; context.fillStyle = "#7799bb"; context.fillRect(0, 0, width, height);
      return canvas.toDataURL("image/png").split(",")[1]!;
    };
    window.testImageBytes = image(900, 1600);
    window.testMarkdownImageBytes = image(1600, 900);
  });
  const gui = page.frameLocator("iframe");
  const editor = gui.getByTestId("agent-gui-composer-editor");
  await expect(editor).toBeVisible();
  for (const withText of [true, false]) {
    if (withText) await editor.fill("Describe this image");
    if (entry === "paste") {
      await editor.evaluate((element, data) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([Uint8Array.from(atob(data), (character) => character.charCodeAt(0))], "screenshot.png", { type: "image/png" }));
        element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
      }, png);
    } else {
      const chooser = page.waitForEvent("filechooser", { timeout: 3000 });
      await gui.getByTestId("agent-gui-composer-add-content-trigger").click();
      await (await chooser).setFiles({ name: "screenshot.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    }
    const number = withText ? 1 : 2;
    await expect(page.locator("body")).toHaveAttribute("data-upload-count", String(number));
    const draft = gui.getByTestId("agent-gui-composer-image-draft");
    await expect(draft).toBeVisible();
    await expect(draft).not.toHaveAttribute("data-uploading", "true");
    await expect.poll(() => draft.locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await expect(gui.getByTestId("multica-composer-file-input")).toHaveCount(0);
    const send = gui.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeEnabled();
    await send.click();
    await expect(gui.getByText(`Test reply ${number}`, { exact: true })).toBeVisible();
    await expect(gui.getByTestId("agent-generated-image-artifact").locator("img")).toHaveCount(number - 1);
    await page.evaluate(() => window.dispatchEvent(new Event("test-complete-image")));
    await expect(gui.getByTestId("agent-generated-image-artifact").locator("img")).toHaveCount(number);
    const generated = gui.getByTestId("agent-generated-image-artifact").locator("img").last();
    await expect.poll(() => generated.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    const markdown = gui.getByRole("img", { name: "Local chart", exact: true }).last();
    await expect.poll(() => markdown.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    for (const output of [generated, markdown]) {
      const image = await output.evaluate((image: HTMLImageElement) => ({ width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height, ratio: image.naturalWidth / image.naturalHeight }));
      expect(image.width).toBeLessThanOrEqual(260);
      expect(image.height).toBeLessThanOrEqual(260);
      expect(image.width / image.height).toBeCloseTo(image.ratio, 2);
    }
    const sent = await page.locator("body").evaluate((body) => JSON.parse(body.dataset.sends!));
    expect(sent[number - 1].attachmentIds).toEqual([`image-${number}`]);
    expect(sent[number - 1].content).not.toContain("data:image/");
    expect(sent[number - 1].content).not.toContain("base64,");
    const preview = gui.getByRole("img", { name: "screenshot.png", exact: true }).first();
    await expect(preview).toBeVisible();
    await expect.poll(() => preview.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    const card = preview.locator("xpath=ancestor::*[contains(@class,'user-image-thumbnail')]");
    const bounds = await card.boundingBox();
    expect(bounds).not.toBeNull();
    expect(Math.abs(bounds!.width - bounds!.height)).toBeLessThan(1);
    await expect(card).toHaveCSS("overflow", "hidden");
    await expect(preview).toHaveCSS("object-fit", "cover");
    await expect(gui.getByText(/\[Image attachment:/)).toHaveCount(0);
  }
  for (const output of [gui.getByTestId("agent-generated-image-artifact").locator("img").first(), gui.getByRole("img", { name: "Local chart", exact: true }).first()]) {
    const original = await output.getAttribute("src");
    await output.locator("..").getByRole("button", { name: "Zoom image", exact: true }).click();
    const dialog = gui.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("img")).toHaveAttribute("src", original!);
    const large = await dialog.locator("img").boundingBox();
    expect(Math.max(large!.width, large!.height)).toBeGreaterThan(260);
    await dialog.press("Escape");
    await expect(dialog).not.toBeVisible();
  }
  if (entry === "upload") {
    await editor.fill("Read the local images and cases file");
    const chooser = page.waitForEvent("filechooser");
    await gui.getByTestId("agent-gui-composer-add-content-trigger").click();
    await (await chooser).setFiles([
      { name: "second screenshot.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") },
      { name: "third screenshot.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") },
      { name: "cases with spaces.pos", mimeType: "application/octet-stream", buffer: Buffer.alloc(7_600_000, 65) },
    ]);
    await expect(page.locator("body")).toHaveAttribute("data-upload-count", "5");
    await expect(gui.getByTestId("agent-gui-composer-image-draft")).toHaveCount(2);
    await gui.getByRole("button", { name: "Send", exact: true }).click();
    await expect(gui.getByText("Test reply 3", { exact: true })).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event("test-complete-image")));
    const sent = await page.locator("body").evaluate((body) => JSON.parse(body.dataset.sends!));
    expect([...sent[2].attachmentIds].sort()).toEqual(["image-3", "image-4", "image-5"]);
    expect(sent[2].content.length).toBeLessThan(2000);
    expect(sent[2].content).toContain("file:///private/multica/files/image-5");
    expect(sent[2].content.includes("base64")).toBe(false);
    const cards = gui.locator('.agent-gui-conversation__user-image-thumbnail');
    for (const card of await cards.all()) {
      const bounds = await card.boundingBox();
      expect(bounds!.width).toBeCloseTo(bounds!.height, 0);
    }
  }
  await page.locator("iframe").evaluate((frame: HTMLIFrameElement) => { frame.setAttribute("src", frame.getAttribute("src")!); });
  await expect(gui.getByTestId("agent-generated-image-artifact").locator("img")).toHaveCount(entry === "upload" ? 3 : 2);
  await expect.poll(() => gui.getByTestId("agent-generated-image-artifact").locator("img").first().evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await expect(page.locator("body")).not.toHaveAttribute("data-failure");
});

declare global { interface Window { testImageBytes: string; testMarkdownImageBytes: string } }
