import "./env";
import { test, expect } from "@playwright/test";
import pg from "pg";
import { createTestApi } from "./helpers";

test("reads cloud-compatible history and preserves a rejected multi-agent draft", async ({ page, context }) => {
  test.setTimeout(60_000);
  const api = await createTestApi();
  const database = new pg.Client(process.env.DATABASE_URL!);
  await database.connect();
  try {
    const workspace = await api.ensureWorkspace();
    const runtime = await api.seedRuntime("Unconnected cloud compatibility runtime", "codex");
    const root = await api.createAgent("Codex", runtime);
    const reviewer = await api.createAgent("Cloud reviewer", runtime);
    const user = await database.query('SELECT id FROM "user" WHERE email=$1', [api.getEmail()]);
    const created = await database.query("INSERT INTO chat_session(workspace_id,agent_id,creator_id,title,status,explicitly_created_at) VALUES($1,$2,$3,'Cloud history compatibility','active',now()) RETURNING id", [workspace.id, root.id, user.rows[0].id]);
    const sessionId = created.rows[0].id;
    await database.query("INSERT INTO chat_message(chat_session_id,role,content) VALUES($1,'assistant','EXISTING_CLOUD_HISTORY')", [sessionId]);
    await context.addInitScript((token) => { if (window === window.top) localStorage.setItem("multica_token", token!); }, api.getToken());
    await page.route(`**/api/chat/sessions/${sessionId}/tasks?*`, (route) => route.fulfill({ status: 404, json: { error: "Not found" } }));
    let invocations = 0;
    await page.route(`**/api/chat/sessions/${sessionId}/agent-messages`, (route) => {
      invocations++;
      return route.fulfill({ status: 404, json: { error: "Not found" } });
    });
    const legacyRead = page.waitForResponse((response) => response.url().includes(`/api/agents/${root.id}/tasks?`) && response.status() === 200);
    await page.goto(`/${workspace.slug}/conversations?session=${sessionId}`);
    const gui = page.frameLocator('[data-testid="tutti-agent-gui-host"] iframe');
    const editor = gui.getByTestId("agent-gui-composer-editor");
    await expect(gui.getByText("EXISTING_CLOUD_HISTORY", { exact: false })).toBeVisible({ timeout: 30_000 });
    await legacyRead;
    await editor.fill("@");
    await gui.getByRole("tab", { name: "Agents", exact: true }).click();
    await gui.getByRole("option").filter({ hasText: reviewer.name }).click();
    await editor.pressSequentially(" CLOUD_UNSENT_REVIEW");
    await gui.getByTestId("agent-gui-composer-send").click();
    await expect(gui.getByRole("alert").filter({ hasText: "This server does not support invoking mentioned agents" })).toBeVisible();
    await expect(editor).toContainText("CLOUD_UNSENT_REVIEW");
    await expect(editor).toContainText(reviewer.name);
    await gui.getByTestId("agent-gui-composer-send").click();
    await expect.poll(() => invocations).toBe(2);
    await expect(gui.getByRole("alert").filter({ hasText: "This server does not support invoking mentioned agents" })).toBeVisible();
    expect((await database.query("SELECT count(*)::int AS count FROM agent_task_queue WHERE chat_session_id=$1", [sessionId])).rows[0].count).toBe(0);
  } finally {
    await database.end();
    await api.cleanup();
    await api.deleteWorkspace();
  }
});
