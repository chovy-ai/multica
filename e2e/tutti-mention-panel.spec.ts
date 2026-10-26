import "./env";
import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import type { AgentGuiInitSnapshot } from "../packages/tutti-agent-gui-host/src/protocol";

async function mountMentions(page: Page, width: number, height: number, theme: "light" | "dark", locale: "en" | "zh-CN") {
  const at = "2026-10-24T18:00:00Z";
  const session = { id: "mention-session", workspace_id: "mention-workspace", creator_id: "mention-user", agent_id: "local:codex", title: "Mention panel review", status: "active" as const, created_at: at, updated_at: at, has_unread: false };
  const snapshot: AgentGuiInitSnapshot = {
    workspaceId: session.workspace_id, workspaceSlug: "mention-test", userId: session.creator_id,
    locale, theme, local: true, hostActive: true, hostVisible: true,
    agents: [], sessions: [session], activeSessionId: session.id, selectedAgentId: session.agent_id,
    executionTargets: [{ id: session.agent_id, provider: "codex", name: "Codex", iconUrl: "", canInvoke: true, runtimeBound: true, runtimeOnline: true }],
  };
  await page.route("**/__test/mention-panel", (route) => route.fulfill({ contentType: "text/html", body: '<style>body{margin:0}iframe{display:block;width:100vw;height:100vh;border:0}</style><iframe title="Mention panel review"></iframe>' }));
  await page.setViewportSize({ width, height });
  await page.goto("/__test/mention-panel");
  await page.evaluate(({ snapshot, session }) => {
    const frame = document.querySelector("iframe")!;
    const storage = new Map<string, string>();
    window.addEventListener("message", (event) => {
      if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== "multica:agent-gui:ready") return;
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => {
        const request = event.data;
        if (request.type !== "request") return;
        let result: unknown;
        switch (request.method) {
          case "workspace.load": result = snapshot; break;
          case "session.load": result = { session, messages: [{ id: "saved-reply", chat_session_id: session.id, role: "assistant", content: "Select a task to reference.", created_at: session.created_at }], tasks: [], pending: {} }; break;
          case "context.tasks": result = Array.from({ length: 24 }, (_, index) => ({ id: `issue-${index}`, label: `TES-${130 + index} ${index === 0 ? "review pr" : "游客访问授权改为开启后永久有效，取消未登录态限制，并确认附件与讨论中的所有验收信息。".repeat(3)}`, status: index === 7 ? "qa" : ["done", "blocked", "in_review", "in_progress", "todo", "backlog", "cancelled"][index % 7], ...(index === 7 ? { statusLabel: "等待验收", statusCategory: "started" } : {}) })).filter((item) => item.label.toLowerCase().includes(request.params.query.toLowerCase())).slice(0, request.params.limit); break;
          case "session.send":
            document.body.dataset.sentMessage = JSON.stringify(request.params);
            result = { message_id: "sent-message", task_id: "sent-turn", created_at: session.created_at };
            break;
          case "task.messages": result = []; break;
          case "storage.read": result = storage.get(request.params.key) ?? null; break;
          case "storage.write": storage.set(request.params.key, request.params.value); break;
          case "models.list": result = { id: "mention-models", runtime_id: session.agent_id, status: "completed", supported: true, models: [] }; break;
          case "usage.read": result = { provider: "codex", context: { usedTokens: null, limitTokens: null, model: null, updatedAt: null }, account: { status: "unavailable", windows: [], plan: null, updatedAt: null } }; break;
          case "session.watch": case "session.markRead": case "host.promptApplied": break;
          default: document.body.dataset.unexpectedRequest = request.method;
        }
        channel.port1.postMessage({ type: "response", id: request.id, result });
      };
      channel.port1.start();
      frame.contentWindow!.postMessage({ type: "multica:agent-gui:connect", snapshot }, location.origin, [channel.port2]);
    });
    frame.src = "/tutti-agent-gui/index.html";
  }, { snapshot, session });
  const gui = page.frameLocator('iframe[title="Mention panel review"]');
  const editor = gui.getByTestId("agent-gui-composer-editor");
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await editor.fill("@");
  await mkdir(".tmp/mention-panel", { recursive: true });
  await page.screenshot({ path: `.tmp/mention-panel/open-${width}.png` });
  await gui.getByRole("tab", { name: locale === "zh-CN" ? "任务" : "Tasks", exact: true }).click();
  const panel = gui.getByTestId("agent-gui-mention-palette-surface");
  await expect(panel.getByRole("option").first()).toBeVisible();
  return { gui, editor, panel };
}

for (const [width, height, theme, locale] of [
  [1100, 800, "light", "zh-CN"], [1440, 900, "dark", "en"], [620, 540, "dark", "zh-CN"], [420, 620, "light", "zh-CN"],
] as const) test(`task references remain readable and selectable at ${width}x${height} in ${theme} ${locale}`, async ({ page }) => {
  test.setTimeout(30_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { gui, editor, panel } = await mountMentions(page, width, height, theme, locale);
  await mkdir(".tmp/mention-panel", { recursive: true });
  await expect(panel.getByRole("option").first()).toContainText(locale === "zh-CN" ? "新建任务" : "New task");
  await expect(panel.getByRole("option").nth(1)).toContainText(locale === "zh-CN" ? "已完成" : "Done");
  await expect(panel.getByText("等待验收", { exact: true })).toHaveCount(1);
  await expect(panel.getByText("查看产物", { exact: true })).toHaveCount(0);
  await expect(panel.locator('[data-category="done"]').first()).toBeVisible();
  expect(await panel.locator(".multica-mention-task-title").nth(2).evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  const scroll = panel.locator(".rich-text-at-mention-palette__scroll-body");
  const header = panel.locator(".rich-text-at-mention-palette__header");
  const footer = panel.locator(".rich-text-at-mention-palette__footer");
  const headerY = (await header.boundingBox())!.y;
  await panel.screenshot({ path: `.tmp/mention-panel/after-${theme}-${width}.png`, animations: "disabled" });
  for (let index = 0; index < 18; index++) {
    await editor.press("ArrowDown");
    const selected = panel.locator('.rich-text-at-mention-palette__row-button[data-highlighted], .rich-text-at-mention-palette__expand-button[data-highlighted]');
    const [selectedRect, headerRect, footerRect] = await Promise.all([selected.boundingBox(), header.boundingBox(), footer.boundingBox()]);
    expect(selectedRect!.y).toBeGreaterThanOrEqual(headerRect!.y + headerRect!.height - 1);
    expect(selectedRect!.y + selectedRect!.height).toBeLessThanOrEqual(footerRect!.y + 1);
  }
  expect(await scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect((await header.boundingBox())!.y).toBe(headerY);
  await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event("scroll")); });
  await expect(panel.getByRole("option")).toHaveCount(25);
  await expect(panel.locator("[data-load-more-group]")).toHaveCount(0);
  await expect(editor).toBeFocused();
  if (!await panel.locator('[role="option"][aria-selected="true"]').count()) await editor.press("ArrowUp");
  const selectedTitle = await panel.locator('[role="option"][aria-selected="true"] .multica-mention-task-row').getAttribute("title");
  await editor.press("Enter");
  await expect(panel).not.toBeVisible();
  await expect(editor).toContainText(selectedTitle!);
  await expect(editor).toBeFocused();
  await editor.fill("@missing-task");
  await expect(panel.getByRole("option")).toHaveCount(1);
  await expect(panel.getByRole("option").first()).toContainText(locale === "zh-CN" ? "新建任务" : "New task");
  await editor.press("Escape");
  await expect(panel).not.toBeVisible();
  await expect(editor).toBeFocused();
  expect(await gui.locator("body").evaluate((element) => element.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator("body")).not.toHaveAttribute("data-unexpected-request");
  expect(errors).toEqual([]);
});

for (const theme of ["light", "dark"] as const) test(`inserts New task as a mention and sends its action to the local agent in ${theme}`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { gui, editor, panel } = await mountMentions(page, 1100, 800, theme, "en");
  await editor.fill("Please review @Write acceptance checks");
  const action = panel.getByRole("option").filter({ hasText: "New task" });
  await expect(action).toBeVisible();
  await expect(action.locator(".multica-mention-task-row")).toHaveAttribute("title", "New task: Write acceptance checks");
  await action.click();
  await expect(gui.getByRole("dialog")).toHaveCount(0);
  await expect(editor).toContainText("New task: Write acceptance checks");
  await expect(editor).toBeFocused();
  await editor.locator('[data-agent-mention-kind="workspace-issue"][data-agent-mention-href]').first().click();
  await expect(editor).toBeFocused();
  await expect(page.locator("body")).not.toHaveAttribute("data-sent-message");
  await expect(page.locator("body")).not.toHaveAttribute("data-unexpected-request");
  await mkdir(".tmp/task-creation", { recursive: true });
  await page.screenshot({ path: `.tmp/task-creation/mention-${theme}.png`, animations: "disabled" });
  await editor.fill("");
  await editor.fill("Please review @Write acceptance checks");
  await expect(action).toBeVisible();
  await expect(action.locator(".multica-mention-task-row")).toHaveAttribute("title", "New task: Write acceptance checks");
  await editor.press("ArrowDown");
  await editor.press("Enter");
  await expect(gui.getByRole("dialog")).toHaveCount(0);
  await expect(editor).toContainText("New task: Write acceptance checks");
  await expect(editor).toBeFocused();
  await editor.press("Enter");
  await expect(page.locator("body")).toHaveAttribute("data-sent-message");
  const sent = JSON.parse((await page.locator("body").getAttribute("data-sent-message"))!);
  expect(sent.references).toEqual([{ kind: "issue", id: "multica:create-task" }]);
  expect(sent.content).toContain("Write acceptance checks");
  expect(sent.content).toContain("Please review");
  await expect(page.locator("body")).not.toHaveAttribute("data-unexpected-request");
  expect(errors).toEqual([]);
});
