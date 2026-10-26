import "./env";
import { expect, test } from "@playwright/test";
import type { AgentGuiInitSnapshot } from "../packages/tutti-agent-gui-host/src/protocol";
import type { ChatSession } from "../packages/core/types";

for (const [provider, initialView] of [["codex", "home"], ["codex", "draft"], ["claude", "home"], ["claude", "draft"], ["codex", "side"]] as const) {
  test(`keeps the ${provider} ${initialView} welcome send button on the right`, async ({ page }) => {
    const at = "2026-10-24T10:00:00Z";
    const name = provider === "codex" ? "Codex" : "Claude Code";
    const chinese = provider === "codex";
    const session = { id: "welcome-draft", workspace_id: "welcome-workspace", creator_id: "welcome-user", agent_id: `local:${provider}`, title: "New conversation", status: "active", created_at: at, updated_at: at, has_unread: false } as ChatSession;
    const snapshot: AgentGuiInitSnapshot = {
      workspaceId: session.workspace_id, workspaceSlug: "welcome-test", userId: session.creator_id,
      locale: chinese ? "zh-CN" : "en", theme: chinese ? "dark" : "light", local: true, hostActive: true, hostVisible: true,
      agents: [], sessions: initialView !== "home" ? [session] : [], activeSessionId: initialView !== "home" ? session.id : null, selectedAgentId: session.agent_id, sidePane: initialView === "side",
      executionTargets: ["codex", "claude"].map((id) => ({ id: `local:${id}`, provider: id, name: id === "codex" ? "Codex" : "Claude Code", iconUrl: "", canInvoke: true, runtimeBound: true, runtimeOnline: true })),
    };
    const errors: string[] = [];
    const loadedCovers = new Set<string>();
    page.on("response", (response) => {
      const cover = /\/assets\/(codex|claude)-vinyl-[^/]+\.png(?:\?|$)/.exec(response.url());
      if (cover && response.status() === 200 && response.headers()["content-type"]?.startsWith("image/")) loadedCovers.add(cover[1]!);
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/__test/welcome-draft", (route) => route.fulfill({ contentType: "text/html", body: '<iframe title="Welcome test" style="display:block;width:100%;height:850px;border:0"></iframe>' }));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__test/welcome-draft");
    await page.evaluate(({ snapshot, session, at }) => {
      const storage = new Map<string, string>();
      const frame = document.querySelector("iframe")!;
      let sent = false;
      let completed = false;
      let port: MessagePort;
      document.addEventListener("complete-welcome-turn", () => {
        completed = true;
        port.postMessage({ type: "event", event: { type: "invalidate", scope: "session", sessionId: session.id } });
        port.postMessage({ type: "event", event: { type: "invalidate", scope: "workspace" } });
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
            case "attachment.upload": {
              const file = request.params.file as File;
              const url = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(file); });
              result = { id: "welcome-image", filename: file.name, content_type: file.type, size_bytes: file.size, url }; break;
            }
            case "workspace.load": result = { ...snapshot, pendingTasks: sent && !completed ? [{ task_id: "welcome-turn", status: "running", chat_session_id: session.id }] : [] }; break;
            case "session.create": snapshot.sessions = [session]; result = session; break;
            case "session.load": result = { session, messages: sent ? [
              { id: "welcome-user-message", chat_session_id: session.id, role: "user", content: "First message", task_id: "welcome-turn", created_at: at },
              ...(completed ? [{ id: "welcome-reply", chat_session_id: session.id, role: "assistant", content: "FIRST_REPLY_RENDERED", task_id: "welcome-turn", created_at: at }] : []),
            ] : [], tasks: sent ? [{ id: "welcome-turn", agent_id: session.agent_id, runtime_id: session.agent_id, chat_session_id: session.id, kind: "chat", status: completed ? "completed" : "running", priority: 0, created_at: at, ...(completed ? { completed_at: at } : {}) }] : [], pending: sent && !completed ? { task_id: "welcome-turn", status: "running", created_at: at } : {} }; break;
            case "session.send": sent = true; result = { message_id: "welcome-user-message", task_id: "welcome-turn", created_at: at }; break;
            case "task.messages": case "context.tasks": result = []; break;
            case "storage.read": result = storage.get(request.params.key) ?? null; break;
            case "storage.write": storage.set(request.params.key, request.params.value); break;
            case "usage.read": result = { provider: session.agent_id === "local:claude" ? "claude" : "codex", context: { usedTokens: null, limitTokens: null, model: null, updatedAt: null }, account: { status: "unavailable", windows: [] } }; break;
            case "models.list": result = { id: "welcome-models", runtime_id: session.agent_id, status: "completed", supported: true, models: [] }; break;
            case "host.selectSession": case "session.watch": case "session.markRead": case "host.promptApplied": break;
            default: channel.port1.postMessage({ type: "response", id: request.id, error: { message: `Unexpected request: ${request.method}` } }); return;
          }
          channel.port1.postMessage({ type: "response", id: request.id, result });
        };
        channel.port1.start();
        frame.contentWindow!.postMessage({ type: "multica:agent-gui:connect", snapshot }, location.origin, [channel.port2]);
      });
      frame.src = "/tutti-agent-gui/index.html";
    }, { snapshot, session, at });
    const gui = page.frameLocator("iframe");
    const editor = gui.getByTestId("agent-gui-composer-editor");
    const welcome = gui.locator(".agent-gui-node__empty-hero-title");
    const startupError = gui.getByRole("alert");
    await expect(editor.or(startupError)).toBeVisible({ timeout: 30_000 });
    expect(await startupError.count() ? await startupError.textContent() : null).toBeNull();
    if (initialView !== "side") {
      await expect(welcome).toBeVisible();
      await expect(welcome).toContainText(name);
      await expect(gui.locator(".agent-gui-node__empty-hero-carousel")).toBeVisible();
      await expect(gui.locator(".agent-gui-node__empty-hero-carousel")).toHaveAttribute("data-icons-ready", "true");
      await expect.poll(() => [...loadedCovers].sort(), { message: "both local providers preload their vinyl covers before drawing the carousel" }).toEqual(["claude", "codex"]);
    }
    const recordIcon = gui.locator(".agent-gui-vinyl-player__label > img");
    const expectRecordIcon = async (selected: "codex" | "claude") => {
      await expect(recordIcon).toBeVisible();
      await expect(recordIcon).toHaveAttribute("src", selected === "codex"
        ? /codex[^/]*\.png/ : /claude[^/]*\.png/);
      await expect.poll(() => recordIcon.evaluate((image: HTMLImageElement) =>
        image.complete && image.naturalWidth > 0 && image.naturalHeight > 0)).toBe(true);
    };
    if (initialView !== "side") await expectRecordIcon(provider);
    await expect(editor).toHaveCount(1);
    const expectSendOnRight = async () => {
      const send = gui.locator(".agent-gui-node__composer-send-button, .agent-gui-node__composer-stop-button");
      const shell = gui.getByTestId("agent-gui-composer-input-shell");
      const controls = gui.locator(".multica-composer-footer-controls");
      await expect.poll(async () => {
        const [button, input, footer, text] = await Promise.all([send.boundingBox(), shell.boundingBox(), controls.boundingBox(), editor.boundingBox()]);
        if (!button || !input || !footer || !text) return false;
        return input.x + input.width - (button.x + button.width) >= 8
          && input.x + input.width - (button.x + button.width) <= 24
          && Math.abs(button.y + button.height - (footer.y + footer.height)) <= 2
          && button.y >= text.y + text.height
          && input.y + input.height - (button.y + button.height) >= 6
          && input.y + input.height - (button.y + button.height) <= 16;
      }, { message: "send stays at the composer's bottom-right beside usage/model/provider controls" }).toBe(true);
    };
    const expectWelcomeComposerNearby = async () => {
      const [title, input] = await Promise.all([welcome.boundingBox(), gui.getByTestId("agent-gui-composer-input-shell").boundingBox()]);
      expect(title).not.toBeNull();
      expect(input).not.toBeNull();
      const gap = input!.y - (title!.y + title!.height);
      expect(gap).toBeGreaterThanOrEqual(16);
      expect(gap).toBeLessThanOrEqual(64);
      expect(input!.y).toBeLessThan(600);
    };
    await expectSendOnRight();
    if (initialView === "side") {
      await expect(welcome).toBeHidden();
      expect((await editor.boundingBox())!.y).toBeGreaterThan(600);
      expect(errors).toEqual([]);
      return;
    }
    await expectWelcomeComposerNearby();
    const expectHomeHelperTray = async () => {
      const tray = gui.locator('.agent-gui-node__composer-hero .agent-gui-node__composer-project-row');
      await expect(tray.getByTestId("agent-gui-prompt-tips")).toBeVisible();
      await expect.poll(async () => {
        const [input, helper] = await Promise.all([gui.getByTestId("agent-gui-composer-input-shell").boundingBox(), tray.boundingBox()]);
        if (!input || !helper) return false;
        return helper.y >= input.y + input.height - 1
          && helper.x > input.x
          && helper.x + helper.width < input.x + input.width;
      }, { message: "home tips sit in an inset tray below the input" }).toBe(true);
      await expect(tray).toHaveCSS("background-color", await tray.evaluate((element) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--muted)"; element.append(probe);
        const color = getComputedStyle(probe).color; probe.remove(); return color;
      }));
      await expect(gui.locator('.agent-gui-node__composer-hero .agent-gui-node__composer-input-group-hero')).toHaveCSS("border-top-width", "0px");
    };
    await expectHomeHelperTray();
    await expect(gui.getByTestId("agent-gui-composer-add-content-trigger")).toBeEnabled();
    await page.screenshot({ path: `.tmp/welcome-${initialView}-${provider}.png` });
    if (initialView === "home") {
      await editor.fill("A longer draft that must leave room for the send button.\n".repeat(6));
      await page.setViewportSize({ width: 640, height: 900 });
      await expectSendOnRight();
      await expectHomeHelperTray();
      await page.screenshot({ path: `.tmp/welcome-home-${provider}-narrow.png` });
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    if (initialView === "draft") {
      await editor.fill("A longer draft that must leave room for the send button.\n".repeat(6));
      await page.setViewportSize({ width: 640, height: 900 });
      await expectSendOnRight();
      await expectWelcomeComposerNearby();
      await expectHomeHelperTray();
      await page.screenshot({ path: `.tmp/welcome-draft-${provider}-narrow.png` });
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    await editor.fill("Use this picture to create an avatar.\nKeep the draft editable.\nPreserve the image.");
    await editor.evaluate(async (element) => {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 72;
      const drawing = canvas.getContext("2d")!; drawing.fillStyle = "teal"; drawing.fillRect(0, 0, 72, 72);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"));
      const clipboard = new DataTransfer(); clipboard.items.add(new File([blob], "picture.png", { type: "image/png" }));
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }));
    });
    const imageDraft = gui.getByTestId("agent-gui-composer-image-draft");
    await expect(imageDraft).toBeVisible();
    await expect(imageDraft).not.toHaveAttribute("data-uploading", "true");
    await expect.poll(() => imageDraft.locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await expectWelcomeComposerNearby();
    await expectSendOnRight();
    await page.screenshot({ path: `.tmp/welcome-${initialView}-${provider}-image.png`, animations: "disabled" });
    await imageDraft.getByRole("button", { name: chinese ? "移除" : "Remove", exact: true }).click();
    await expect(imageDraft).not.toBeVisible();
    await editor.fill("First message");
    await expectSendOnRight();
    await gui.getByRole("button", { name: chinese ? "发送" : "Send", exact: true }).click();
    await expect(gui.getByTestId("agent-gui-composer-stop-active-turn")).toBeVisible();
    await expect(welcome).toHaveCount(0);
    expect((await editor.boundingBox())!.y).toBeGreaterThan(600);
    await expectSendOnRight();
    await page.evaluate(() => document.dispatchEvent(new Event("complete-welcome-turn")));
    await expect(gui.getByText("FIRST_REPLY_RENDERED", { exact: true })).toBeVisible();
    await expect(welcome).toHaveCount(0);
    await expect(editor).toHaveCount(1);
    await expectSendOnRight();
    if (initialView === "draft") {
      const providerPicker = gui.getByRole("button", { name: chinese ? "本机运行器" : "Local provider", exact: true });
      const otherProvider = provider === "codex" ? "claude" : "codex";
      await providerPicker.click();
      await gui.getByRole("menuitemradio", { name: otherProvider === "codex" ? "Codex" : "Claude Code", exact: true }).click();
      await expectRecordIcon(otherProvider);
      await expectHomeHelperTray();
      await providerPicker.click();
      await gui.getByRole("menuitemradio", { name, exact: true }).click();
      await expectRecordIcon(provider);
      await expectHomeHelperTray();
    }
    expect(errors).toEqual([]);
  });
}
