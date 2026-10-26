import "./env";
import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import pg from "pg";
import { createTestApi } from "./helpers";

test("reveals and focuses new conversations while preserving drafts and repeated reference choices", async ({ page, context }) => {
  test.setTimeout(90_000);
  const api = await createTestApi();
  const database = new pg.Client(process.env.DATABASE_URL!);
  await database.connect();
  try {
    const workspace = await api.ensureWorkspace();
    const runtime = await api.seedRuntime("Unconnected interaction test runtime", "codex");
    const root = await api.createAgent("Codex", runtime);
    const design = await api.createAgent("Design reviewer", runtime);
    const code = await api.createAgent("Code reviewer", runtime);
    const user = await database.query('SELECT id FROM "user" WHERE email=$1', [api.getEmail()]);
    const created = await database.query("INSERT INTO chat_session(workspace_id,agent_id,creator_id,title,status,explicitly_created_at) VALUES($1,$2,$3,'Saved interaction review','active',now()),($1,$2,$3,'Archived interaction review','archived',now()) RETURNING id,status", [workspace.id, root.id, user.rows[0].id]);
    const sessionId = created.rows.find((row) => row.status === "active").id;
    await database.query("INSERT INTO chat_message(chat_session_id,role,content) VALUES($1,'user','Saved conversation prompt')", [sessionId]);
    await context.addInitScript((token) => { if (window === window.top) localStorage.setItem("multica_token", token!); }, api.getToken());
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/${workspace.slug}/conversations?session=${sessionId}`);
    const list = page.getByTestId("conversation-flow-sessions");
    const search = list.getByRole("textbox", { name: "Search conversations", exact: true });
    const newConversation = list.getByRole("button", { name: "New conversation", exact: true });
    const gui = page.frameLocator('[data-testid="tutti-agent-gui-host"] iframe');
    const editor = gui.getByTestId("agent-gui-composer-editor");
    const panel = gui.getByTestId("agent-gui-mention-palette-surface");
    const agentsTab = gui.getByRole("tab", { name: "Agents", exact: true });
    await expect(editor).toBeVisible({ timeout: 30_000 });
    await editor.fill("ORIGINAL_UNSENT_DRAFT");
    // A target change must leave the old GUI conversation before selecting the
    // next target, or the old conversation's metadata restores its executor.
    const targetPicker = gui.getByTestId("multica-agent-picker");
    await targetPicker.click();
    await gui.getByRole("menuitemradio", { name: design.name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`agent=${design.id}`));
    await expect(targetPicker).toContainText(design.name);
    await expect(editor).toBeEmpty();
    await list.getByText("Saved interaction review", { exact: true }).click();
    await expect(editor).toContainText("ORIGINAL_UNSENT_DRAFT");
    await search.fill("Saved interaction");

    const rejectCreate = async (route: import("@playwright/test").Route) => {
      if (route.request().method() === "POST") await route.fulfill({ status: 500, json: { error: "Test create failure" } });
      else await route.continue();
    };
    await page.route("**/api/chat/sessions", rejectCreate);
    const rejected = page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/chat\/sessions$/.test(response.url()));
    await newConversation.click();
    expect((await rejected).status()).toBe(500);
    await expect(newConversation).toBeEnabled();
    await expect(search).toHaveValue("Saved interaction");
    await expect(editor).toContainText("ORIGINAL_UNSENT_DRAFT");
    await page.unroute("**/api/chat/sessions", rejectCreate);

    const createConversation = async () => {
      const accepted = page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/chat\/sessions$/.test(response.url()));
      await newConversation.click();
      const response = await accepted;
      expect(response.status()).toBe(201);
      const session = await response.json() as { id: string };
      await expect(page).toHaveURL(new RegExp(`session=${session.id}`));
      await expect(search).toHaveValue("");
      await expect(list.locator('[aria-current="true"]')).toBeVisible();
      await expect(editor).toBeEmpty();
      await expect(editor).toBeFocused();
      return session;
    };
    await createConversation();
    await expect(page.getByText("Could not update the conversation. Try again.", { exact: true })).not.toBeVisible();
    await mkdir(".tmp/conversation-interaction-refinement", { recursive: true });
    await page.screenshot({ path: ".tmp/conversation-interaction-refinement/04-after-new-conversation.png", animations: "disabled" });
    await editor.pressSequentially("NEW_UNSENT_DRAFT");
    await list.getByText("Saved interaction review", { exact: true }).click();
    await expect(editor).toContainText("ORIGINAL_UNSENT_DRAFT");

    await editor.fill("@Design");
    await agentsTab.click();
    await gui.getByRole("option").filter({ hasText: design.name }).click();
    await editor.pressSequentially(" @");
    await expect(agentsTab).toHaveAttribute("aria-selected", "true");
    await editor.pressSequentially("Code");
    await expect(agentsTab).toHaveAttribute("aria-selected", "true");
    const codeOption = gui.getByRole("option").filter({ hasText: code.name });
    await expect(codeOption).toBeVisible();
    await page.screenshot({ path: ".tmp/conversation-interaction-refinement/05-after-repeat-mention.png", animations: "disabled" });
    await codeOption.click();
    await expect(editor).toContainText(design.name);
    await expect(editor).toContainText(code.name);
    await editor.pressSequentially(" @");
    await expect(agentsTab).toHaveAttribute("aria-selected", "true");
    await editor.press("Escape");
    await expect(panel).not.toBeVisible();
    await expect(editor).toBeFocused();
    await editor.pressSequentially(" @");
    await expect(agentsTab).toHaveAttribute("aria-selected", "true");
    await gui.getByRole("tab", { name: "Sessions", exact: true }).click();
    await editor.press("Escape");
    await editor.pressSequentially(" @");
    await expect(gui.getByRole("tab", { name: "Sessions", exact: true })).toHaveAttribute("aria-selected", "true");
    await editor.fill("");

    await list.getByRole("button", { name: /Archived/ }).click();
    await expect(list.getByText("Archived interaction review", { exact: true })).toBeVisible();
    await search.fill("Archived interaction");
    await createConversation();
    await expect(list.getByText("Archived interaction review", { exact: true })).not.toBeVisible();
    expect((await database.query("SELECT count(*)::int AS count FROM agent_task_queue t JOIN agent a ON a.id=t.agent_id WHERE a.workspace_id=$1", [workspace.id])).rows[0].count).toBe(0);
  } finally {
    await database.end();
    await api.cleanup();
    await api.deleteWorkspace();
  }
});
