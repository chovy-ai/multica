import "./env";
import { expect, test } from "@playwright/test";
import type { AgentGuiInitSnapshot } from "../packages/tutti-agent-gui-host/src/protocol";

for (const provider of ["codex", "claude"] as const) test(`${provider} keeps backfilled image turns in send order and the last response reachable`, async ({ page }) => {
  let releaseImages!: () => void;
  const imagesReady = new Promise<void>((resolve) => { releaseImages = resolve; });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("**/__test/transcript-scroll", (route) => route.fulfill({ contentType: "text/html", body: '<button id="next">Finish turn</button><iframe title="Transcript test" style="display:block;width:100%;height:840px;border:0"></iframe>' }));
  await page.route("**/__test/transcript-image.svg", async (route) => { await imagesReady; await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="#888"/></svg>' }); });
  await page.goto("/__test/transcript-scroll");
  await page.evaluate((provider) => {
    const frame = document.querySelector("iframe")!;
    const at = (index: number) => new Date(Date.now() - 100000 + index * 1000).toISOString();
    const session = { id: "image-history", workspace_id: "test-workspace", creator_id: "user", agent_id: `local:${provider}`, title: "Image history", status: "active" as const, created_at: at(0), updated_at: at(99), has_unread: false };
    const snapshot: AgentGuiInitSnapshot = { workspaceId: session.workspace_id, workspaceSlug: "test", userId: "user", locale: "en", theme: "dark", local: true, hostActive: true, hostVisible: true, agents: [], sessions: [session], activeSessionId: session.id, selectedAgentId: session.agent_id,
      executionTargets: [{ id: session.agent_id, provider, name: provider === "codex" ? "Codex" : "Claude Code", iconUrl: "", canInvoke: true, runtimeBound: true, runtimeOnline: true }] };
    const messages: Record<string, unknown>[] = [];
    const tasks: Record<string, unknown>[] = [];
    const transcripts: Record<string, unknown[]> = {};
    const append = (index: number) => {
      const task = `turn-${index}`;
      messages.push({ id: `user-${index}`, chat_session_id: session.id, task_id: task, role: "user", content: `PROMPT_${index}`, created_at: at(index * 10) });
      messages.push({ id: `reply-${index}`, chat_session_id: session.id, task_id: task, role: "assistant", content: `REPLY_${index}`, created_at: at(index * 10 + 8) });
      tasks.push({ id: task, chat_session_id: session.id, status: "completed", created_at: at(index * 10), started_at: at(index * 10), completed_at: at(index * 10 + 8) });
      transcripts[task] = [{ task_id: task, seq: 1, type: "tool_result", tool: "ImageGeneration", call_id: `image-${index}`, output: JSON.stringify({ savedPath: `${location.origin}/__test/transcript-image.svg`, imageMimeType: "image/svg+xml" }), created_at: at(index * 10 + 9) }];
    };
    for (let index = 0; index < 7; index++) append(index);
    let port: MessagePort;
    document.querySelector("#next")!.addEventListener("click", () => {
      const index = tasks.length - 1;
      const task = tasks[index]!;
      task.status = "completed"; task.completed_at = new Date().toISOString();
      messages.push({ id: `reply-${index}`, chat_session_id: session.id, task_id: task.id, role: "assistant", content: `REPLY_${index}`, created_at: task.completed_at });
      transcripts[String(task.id)]!.push({ task_id: task.id, seq: 2, type: "tool_result", tool: "ImageGeneration", call_id: `image-${index}`, output: JSON.stringify({ savedPath: `${location.origin}/__test/transcript-image.svg`, imageMimeType: "image/svg+xml" }), created_at: task.completed_at });
      port.postMessage({ type: "event", event: { type: "invalidate", scope: "session", sessionId: session.id } });
    });
    const storage = new Map<string, string>();
    window.addEventListener("message", (event) => {
      if (event.source !== frame.contentWindow || event.data?.type !== "multica:agent-gui:ready") return;
      const channel = new MessageChannel(); port = channel.port1;
      port.onmessage = ({ data: request }) => {
        if (request.type !== "request") return;
        const running = tasks.find((t) => t.status === "running");
        let result: unknown;
        switch (request.method) {
          case "workspace.load": result = snapshot; break;
          case "session.load": result = { session, messages, tasks, pending: running ? { task_id: running.id, status: "running", created_at: running.created_at } : {} }; break;
          case "session.send": {
            const index = tasks.length, now = new Date().toISOString();
            tasks.push({ id: `turn-${index}`, status: "running", created_at: now, started_at: now });
            messages.push({ id: `user-${index}`, chat_session_id: session.id, task_id: `turn-${index}`, role: "user", content: request.params.content, created_at: now });
            // A recovered provider frame can carry an earlier source clock.
            transcripts[`turn-${index}`] = [{ task_id: `turn-${index}`, seq: 1, type: "thinking", content: "Recovered execution frame", created_at: at(0) }];
            result = { message_id: `user-${index}`, task_id: `turn-${index}`, created_at: now }; break;
          }
          case "session.cancel": {
            const task = tasks.find((t) => t.id === request.params.taskId)!;
            task.status = "cancelled"; task.completed_at = new Date().toISOString(); result = task; break;
          }
          case "task.messages": result = transcripts[request.params.taskId] ?? []; break;
          case "storage.read": result = storage.get(request.params.key) ?? null; break;
          case "storage.write": storage.set(request.params.key, request.params.value); break;
          case "context.tasks": result = []; break;
          case "models.list": result = { id: "models", status: "completed", supported: true, models: [] }; break;
          case "usage.read": result = { provider, context: { usedTokens: null, limitTokens: null, model: null, updatedAt: null }, account: { status: "unavailable", plan: null, windows: [], updatedAt: null } }; break;
          case "session.watch": case "session.markRead": case "host.selectSession": break;
          default: document.body.dataset.failure = request.method; break;
        }
        port.postMessage({ type: "response", id: request.id, result });
      };
      port.start(); frame.contentWindow!.postMessage({ type: "multica:agent-gui:connect", snapshot }, location.origin, [channel.port2]);
    });
    frame.src = "/tutti-agent-gui/index.html";
  }, provider);
  const gui = page.frameLocator("iframe");
  const timeline = gui.getByTestId("agent-gui-timeline");
  await expect(gui.getByText(/^REPLY_6/).first()).toBeAttached();
  const editor = gui.getByTestId("agent-gui-composer-editor");
  await editor.fill("PROMPT_7");
  await gui.getByRole("button", { name: "Send", exact: true }).click();
  await expect(gui.getByTestId("agent-gui-composer-stop-active-turn")).toBeVisible();
  const locator = gui.getByRole("navigation", { name: "User messages", exact: true });
  const promptOrder = () => locator.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
  await expect.poll(promptOrder).toEqual(Array.from({ length: 8 }, (_, index) => `PROMPT_${index}`));
  await gui.getByTestId("agent-gui-composer-stop-active-turn").click();
  await expect(gui.getByTestId("agent-gui-composer-stop-active-turn")).toHaveCount(0);
  await editor.fill("PROMPT_8");
  await gui.getByRole("button", { name: "Send", exact: true }).click();
  await expect(gui.getByTestId("agent-gui-composer-stop-active-turn")).toBeVisible();
  await expect.poll(promptOrder).toEqual(Array.from({ length: 9 }, (_, index) => `PROMPT_${index}`));
  await page.getByRole("button", { name: "Finish turn" }).click();
  await expect(gui.getByText("REPLY_8", { exact: true })).toBeAttached();
  releaseImages();
  await expect.poll(() => gui.locator('[data-multica-turn-id="turn-8"] img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(800);
  await expect(gui.locator('[data-agent-transcript-virtual-turn="turn-8"]')).toHaveCount(1);
  await expect.poll(() => timeline.evaluate((element) => {
    const groups = [...element.querySelectorAll<HTMLElement>('[data-agent-transcript-virtual-turn]')];
    return groups.every((group, index) => !index || groups[index - 1]!.getBoundingClientRect().bottom <= group.getBoundingClientRect().top + 1);
  })).toBe(true);
  await timeline.hover();
  await page.mouse.wheel(0, -800);
  const scrollToBottom = gui.getByTestId("agent-gui-scroll-to-bottom");
  await expect(scrollToBottom).toBeVisible();
  await scrollToBottom.click();
  await expect.poll(() => timeline.evaluate((element) => {
    const last = element.querySelector('[data-multica-turn-id="turn-8"]')!;
    const image = last.querySelector("img")!;
    const viewport = element.getBoundingClientRect();
    return { scrollEnd: Math.round(element.scrollHeight - element.clientHeight - element.scrollTop), imageVisible: image.getBoundingClientRect().bottom <= viewport.bottom };
  })).toEqual({ scrollEnd: 0, imageVisible: true });
  const lastImage = gui.locator('[data-multica-turn-id="turn-8"] img').last();
  const imageBox = await lastImage.boundingBox();
  const composerBox = await gui.getByTestId("agent-gui-composer-editor").boundingBox();
  expect(imageBox!.y + imageBox!.height).toBeLessThanOrEqual(composerBox!.y);
  await expect(page.locator("body")).not.toHaveAttribute("data-failure");
});
