import "./env";
import { expect, test } from "@playwright/test";
import type { AgentGuiInitSnapshot } from "../packages/tutti-agent-gui-host/src/protocol";

for (const provider of ["codex", "claude"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`${provider} assistant content fills the main conversation in ${theme} mode`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize({ width: 1800, height: 1000 });
      await page.route("**/__test/assistant-width", (route) => route.fulfill({
        contentType: "text/html",
        body: '<body style="margin:0"><iframe title="Conversation width" style="display:block;width:100%;height:100vh;border:0"></iframe></body>',
      }));
      await page.goto("/__test/assistant-width");
      await page.evaluate(({ provider, theme }) => {
        const frame = document.querySelector("iframe")!;
        const at = "2026-10-27T10:00:00Z";
        const session = { id: "width-session", workspace_id: "width-workspace", creator_id: "width-user", agent_id: `local:${provider}`, title: "Assistant width", status: "active" as const, created_at: at, updated_at: at, has_unread: false };
        const snapshot: AgentGuiInitSnapshot = {
          workspaceId: session.workspace_id, workspaceSlug: "width-test", userId: session.creator_id,
          locale: "zh-CN", theme, local: true, hostActive: true, hostVisible: true, sidePane: false,
          agents: [], sessions: [session], activeSessionId: session.id, selectedAgentId: session.agent_id,
          executionTargets: [{ id: session.agent_id, provider, name: provider === "codex" ? "Codex" : "Claude Code", iconUrl: "", canInvoke: true, runtimeBound: true, runtimeOnline: true }],
        };
        let content = [
          "已从最新 `origin/main` 创建独立 worktree。正文、列表和表格应随对话面板宽度扩展，并保留合理边距。",
          "- 目录：`tutti-qa-qa-main-20261027`\n- 分支：`qa/main-20261027`\n  - 工作区干净，与远端 `main` 一致。",
          "| 项目 | 当前状态 | 后续处理 |\n| --- | --- | --- |\n| 工作区 | 已创建独立 worktree | 可以继续开发 |\n| 检查 | 本地验证通过 | 等待评审 |",
          "长路径：`/workspace/" + "long-directory/".repeat(24) + "README.md`",
          "```text\n" + "long-code-token-".repeat(40) + "\n```",
          "| " + Array.from({ length: 12 }, (_, i) => `Column-${i}-long-header`).join(" | ") + " |\n| " + Array(12).fill("---").join(" | ") + " |\n| " + Array(12).fill("wide-table-cell-with-long-value").join(" | ") + " |",
        ].join("\n\n");
        let port: MessagePort;
        let running = false;
        const storage = new Map<string, string>();
        document.addEventListener("width-stream", () => {
          running = true;
          content += "\n\n正在继续检查工作区。";
          port.postMessage({ type: "event", event: { type: "invalidate", scope: "session", sessionId: session.id } });
        });
        document.addEventListener("width-side-pane", () => {
          snapshot.sidePane = true;
          port.postMessage({ type: "event", event: { type: "init", snapshot } });
        });
        window.addEventListener("message", (event) => {
          if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== "multica:agent-gui:ready") return;
          const channel = new MessageChannel();
          port = channel.port1;
          port.onmessage = ({ data: request }) => {
            if (request.type !== "request") return;
            let result: unknown;
            switch (request.method) {
              case "workspace.load": result = snapshot; break;
              case "session.load": result = {
                session,
                messages: [
                  { id: "width-prompt", chat_session_id: session.id, task_id: "width-turn", role: "user", content: "从远端 main 分支创建 worktree", created_at: at },
                  { id: "width-reply", chat_session_id: session.id, task_id: "width-turn", role: "assistant", content, created_at: at },
                ],
                tasks: [{ id: "width-turn", agent_id: session.agent_id, runtime_id: session.agent_id, chat_session_id: session.id, kind: "chat", status: running ? "running" : "completed", priority: 0, created_at: at, started_at: at, ...(!running ? { completed_at: at } : {}) }],
                pending: running ? { task_id: "width-turn", status: "running", created_at: at } : {},
              }; break;
              case "task.messages": case "context.tasks": result = []; break;
              case "storage.read": result = storage.get(request.params.key) ?? null; break;
              case "storage.write": storage.set(request.params.key, request.params.value); break;
              case "models.list": result = { id: "width-models", status: "completed", supported: true, models: [] }; break;
              case "usage.read": result = { provider, context: { usedTokens: null, limitTokens: null, model: null, updatedAt: null }, account: { status: "unavailable", windows: [] } }; break;
              case "host.selectSession": case "session.watch": case "session.markRead": break;
              default: document.body.dataset.failure = request.method; break;
            }
            port.postMessage({ type: "response", id: request.id, result });
          };
          port.start();
          frame.contentWindow!.postMessage({ type: "multica:agent-gui:connect", snapshot }, location.origin, [channel.port2]);
        });
        frame.src = "/tutti-agent-gui/index.html";
      }, { provider, theme });

      const gui = page.frameLocator("iframe");
      const markdown = gui.locator(".agent-gui-conversation__assistant-markdown").first();
      await expect(markdown).toBeVisible();
      await page.locator("iframe").screenshot({ path: `.tmp/assistant-width/${provider}-${theme}-wide.png`, animations: "disabled" });

      // Compare real layout to the transcript's available width, not a CSS declaration.
      const expectFullWidth = async () => {
        await expect.poll(() => markdown.evaluate((element) => {
          const shell = element.parentElement!;
          const body = element.getBoundingClientRect();
          return Math.abs(body.width - shell.getBoundingClientRect().width);
        })).toBeLessThanOrEqual(1);
        const layout = await markdown.evaluate((element) => {
          const body = element.getBoundingClientRect();
          const list = element.querySelector("ul")!.getBoundingClientRect();
          const table = element.querySelector("table")!.getBoundingClientRect();
          const wideTable = element.querySelectorAll("table")[1]!.getBoundingClientRect();
          return { width: body.width, left: body.left, right: body.right, viewport: innerWidth,
            listWidth: list.width, tableWidth: table.width, wideTableWidth: wideTable.width,
            overflowX: getComputedStyle(element).overflowX,
            pageOverflow: document.body.scrollWidth > innerWidth,
          };
        });
        expect(layout.left).toBeGreaterThan(0);
        expect(layout.right).toBeLessThan(layout.viewport);
        expect(Math.abs(layout.listWidth - layout.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(layout.tableWidth - layout.width)).toBeLessThanOrEqual(1);
        expect(layout.overflowX).toBe("auto");
        expect(layout.pageOverflow).toBe(false);
        return layout;
      };
      expect((await expectFullWidth()).width).toBeGreaterThan(880);
      const userBubble = gui.locator(".agent-gui-conversation__user-message-bubble").first();
      expect(await userBubble.evaluate((element) => {
        const bubble = element.getBoundingClientRect();
        const row = element.parentElement!.getBoundingClientRect();
        return bubble.width <= 540 && bubble.width <= row.width * 0.72 && Math.abs(bubble.right - row.right) <= 1;
      })).toBe(true);
      for (const width of [1200, 760, 434, 360, 1800]) {
        await page.locator("iframe").evaluate((frame, width) => { frame.style.width = `${width}px`; }, width);
        const layout = await expectFullWidth();
        if (width === 360) {
          expect(layout.wideTableWidth).toBeGreaterThan(layout.width);
          expect(await markdown.evaluate((element) => { element.scrollLeft = element.scrollWidth; return element.scrollLeft; })).toBeGreaterThan(0);
          await markdown.evaluate((element) => { element.scrollLeft = 0; });
        }
        if (width === 434) {
          await page.mouse.move(200, 200);
          await page.mouse.wheel(0, -10000);
          await expect(markdown.locator("p").first()).toBeInViewport();
          await page.locator("iframe").screenshot({ path: `.tmp/assistant-width/${provider}-${theme}-narrow.png`, animations: "disabled" });
        }
      }
      await page.evaluate(() => document.dispatchEvent(new Event("width-stream")));
      await expect(gui.getByTestId("agent-gui-composer-stop-active-turn")).toBeVisible();
      await expect(markdown).toContainText("正在继续检查工作区。");
      await expectFullWidth();

      await page.evaluate(() => document.dispatchEvent(new Event("width-side-pane")));
      await expect(gui.locator("html")).toHaveAttribute("data-side-pane", "true");
      await expect.poll(() => markdown.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(880);
      await expect(page.locator("body")).not.toHaveAttribute("data-failure");
      expect(errors).toEqual([]);
    });
  }
}
