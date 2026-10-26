import "./env";
import { expect, test } from "@playwright/test";
import type { AgentGuiInitSnapshot } from "../packages/tutti-agent-gui-host/src/protocol";

for (const provider of ["codex", "claude"] as const) for (const custom of [false, true]) test(`${provider} answers a pending question with ${custom ? "custom text" : "choices"} and continues the same turn`, async ({ page }) => {
  await page.route("**/__test/user-question", (route) => route.fulfill({ contentType: "text/html", body: '<iframe title="Question test" style="display:block;width:100%;height:850px;border:0"></iframe>' }));
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto("/__test/user-question");
  await page.evaluate((provider) => {
    const frame = document.querySelector("iframe")!;
    const at = new Date().toISOString();
    const session = { id: "question-session", workspace_id: "question-workspace", creator_id: "question-user", agent_id: `local:${provider}`, title: "Question", status: "active" as const, created_at: at, updated_at: at, has_unread: false };
    const snapshot: AgentGuiInitSnapshot = { workspaceId: session.workspace_id, workspaceSlug: "test", userId: session.creator_id, locale: "en", theme: provider === "codex" ? "light" : "dark", local: true, sidePane: provider === "claude", hostActive: true, hostVisible: true, agents: [], sessions: [session], activeSessionId: session.id, selectedAgentId: session.agent_id,
      executionTargets: [{ id: session.agent_id, provider, name: provider === "codex" ? "Codex" : "Claude Code", iconUrl: "", canInvoke: true, runtimeBound: true, runtimeOnline: true }] };
    const task = { id: "question-turn", chat_session_id: session.id, status: "running", created_at: at, started_at: at };
    const messages = [{ id: "question-message", chat_session_id: session.id, task_id: task.id, role: "user", content: "Ask before proceeding", created_at: at }];
    const questions = [{ turnId: task.id, question: { request_id: "choose-design", status: "pending", createdAt: at, updatedAt: at, questions: [
      { id: "approach", header: "Approach", question: "Which approach should I use?", options: [{ label: "Simple", description: "Keep the current layout" }, { label: "Detailed" }], multiSelect: false, allowFreeText: true },
      { id: "checks", header: "Checks", question: "Which checks should I run?", options: [{ label: "Keyboard" }, { label: "Layout" }], multiSelect: true, allowFreeText: true },
      { id: "note", header: "Details", question: "Any other requirements?", options: [], multiSelect: false, allowFreeText: true },
    ] } }];
    window.addEventListener("message", (event) => {
      if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== "multica:agent-gui:ready") return;
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => {
        const request = event.data;
        if (request.type !== "request") return;
        let result: unknown;
        switch (request.method) {
          case "workspace.load": result = { ...snapshot, pendingTasks: task.status === "running" ? [{ task_id: task.id, status: "running", chat_session_id: session.id }] : [] }; break;
          case "session.load": result = { session, messages, questions, tasks: [task], pending: task.status === "running" ? { task_id: task.id, status: "running", created_at: at } : {} }; break;
          case "interaction.respond":
            document.body.dataset.answer = JSON.stringify(request.params);
            questions[0]!.question.status = "answered";
            Object.assign(questions[0]!.question, { answers: request.params.answers, updatedAt: new Date().toISOString() });
            task.status = "completed";
            messages.push({ id: "question-reply", chat_session_id: session.id, task_id: task.id, role: "assistant", content: "Continued with your choices", created_at: new Date().toISOString() });
            break;
          case "storage.read": result = localStorage.getItem(request.params.key); break;
          case "storage.write": localStorage.setItem(request.params.key, request.params.value); break;
          case "task.messages": case "context.tasks": result = []; break;
          case "session.watch": case "session.markRead": case "host.selectSession": break;
          case "models.list": result = { id: "models", status: "completed", supported: true, models: [] }; break;
          case "usage.read": result = { provider, context: { usedTokens: null, limitTokens: null, model: null, updatedAt: null }, account: { status: "unavailable", plan: null, windows: [], updatedAt: null } }; break;
          default: document.body.dataset.failure = `Unexpected ${request.method}`; channel.port1.postMessage({ type: "response", id: request.id, error: { message: document.body.dataset.failure } }); return;
        }
        channel.port1.postMessage({ type: "response", id: request.id, result });
      };
      channel.port1.start();
      frame.contentWindow!.postMessage({ type: "multica:agent-gui:connect", snapshot }, location.origin, [channel.port2]);
    });
    frame.src = "/tutti-agent-gui/index.html";
  }, provider);
  const gui = page.frameLocator("iframe");
  await expect(gui.getByText("Which approach should I use?", { exact: true })).toBeVisible();
  const customApproach = gui.getByTestId("agent-question-choose-design-approach-custom-answer");
  await expect(customApproach).toBeVisible();
  await gui.getByRole("button", { name: /^Simple/ }).click();
  if (custom) await customApproach.fill("Use my own approach instead");
  await gui.getByRole("button", { name: "Next", exact: true }).click();
  await gui.getByRole("button", { name: "Keyboard", exact: true }).click();
  await gui.getByRole("button", { name: "Layout", exact: true }).click();
  const customChecks = gui.getByTestId("agent-question-choose-design-checks-custom-answer");
  await expect(customChecks).toBeVisible();
  if (custom) {
    await customChecks.fill("Also check accessibility");
    await gui.getByRole("button", { name: "Back", exact: true }).click();
    await expect(customApproach).toHaveValue("Use my own approach instead");
    await gui.getByRole("button", { name: "Next", exact: true }).click();
    await expect(customChecks).toHaveValue("Also check accessibility");
  }
  await gui.getByRole("button", { name: "Next", exact: true }).click();
  await gui.getByTestId("agent-question-choose-design-note-custom-answer").fill("Keep the original colors");
  await page.screenshot({ path: `.tmp/local-conversations/ask-user-${provider}-${custom ? "custom" : "choices"}.png` });
  await gui.getByRole("button", { name: "Submit answers", exact: true }).click();
  await expect(gui.getByText("Continued with your choices", { exact: true })).toBeVisible();
  expect(await page.locator("body").evaluate((element) => JSON.parse(element.dataset.answer!))).toEqual({ sessionId: "question-session", turnId: "question-turn", requestId: "choose-design", answers: { approach: custom ? "Use my own approach instead" : "Simple", checks: custom ? ["Keyboard", "Layout", "Also check accessibility"] : ["Keyboard", "Layout"], note: "Keep the original colors" } });
  await expect(gui.locator('[data-agent-interaction-kind="ask-user"]')).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveAttribute("data-failure");
});
