import "./env";
import { test, expect, type Locator } from "@playwright/test";
import pg from "pg";
import { mkdir } from "node:fs/promises";
import { createTestApi } from "./helpers";

const screenshots = ".tmp/conversation-visual-refinement";

async function frameRect(locator: Locator) {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
      viewportWidth: innerWidth, viewportHeight: innerHeight };
  });
}

async function expectWithinFrame(locator: Locator) {
  const rect = await frameRect(locator);
  expect(rect.width).toBeGreaterThan(0);
  expect(rect.height).toBeGreaterThan(0);
  expect(rect.left).toBeGreaterThanOrEqual(-1);
  expect(rect.top).toBeGreaterThanOrEqual(-1);
  expect(rect.right).toBeLessThanOrEqual(rect.viewportWidth + 1);
  expect(rect.bottom).toBeLessThanOrEqual(rect.viewportHeight + 1);
}

test("keeps the Multica reference panel compact, scrollable and clear of growing drafts in both themes", async ({ page, context }) => {
  test.setTimeout(90_000);
  const api = await createTestApi();
  const database = new pg.Client(process.env.DATABASE_URL!);
  await database.connect();
  try {
    const workspace = await api.ensureWorkspace();
    const runtime = await api.seedRuntime("Unconnected visual test runtime", "codex");
    const root = await api.createAgent("Codex", runtime);
    await database.query("UPDATE agent SET avatar_url=$2 WHERE id=$1", [root.id, "emoji:🐯"]);
    const design = await api.createAgent("Design reviewer", runtime);
    const code = await api.createAgent("Code reviewer", runtime);
    await database.query("UPDATE agent SET description=$2,avatar_url=$3 WHERE id=$1", [design.id, "Review layout, visual hierarchy and interaction details", "emoji:🦉"]);
    await database.query("UPDATE agent SET description=$2,avatar_url=$3 WHERE id=$1", [code.id, "Review implementation and code quality", "emoji:🐙"]);
    for (let index = 1; index <= 18; index++) await api.createAgent(`Reviewer ${String(index).padStart(2, "0")}`, runtime);
    const user = await database.query('SELECT id FROM "user" WHERE email=$1', [api.getEmail()]);
    const created = await database.query("INSERT INTO chat_session(workspace_id,agent_id,creator_id,title,status,explicitly_created_at) VALUES($1,$2,$3,'Visual review','active',now()) RETURNING id", [workspace.id, root.id, user.rows[0].id]);
    const sessionId = created.rows[0].id;
    await database.query("INSERT INTO chat_message(chat_session_id,role,content) VALUES($1,'user',$2),($1,'assistant',$3)", [sessionId, "Review the conversation interface. Keep the existing workflow and make the visual hierarchy consistent with Multica.", "The conversation keeps its session list and message flow.\n\n- Clear reading hierarchy\n- Consistent controls\n- Accessible keyboard navigation"]);
    await context.addInitScript((token) => { if (window === window.top) localStorage.setItem("multica_token", token!); }, api.getToken());
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/${workspace.slug}/conversations?session=${sessionId}`);
    const gui = page.frameLocator('[data-testid="tutti-agent-gui-host"] iframe');
    const editor = gui.getByTestId("agent-gui-composer-editor");
    const panel = gui.getByTestId("agent-gui-mention-palette-surface");
    const area = gui.locator(".agent-gui-node__composer-prompt-input-area");
    await expect(editor).toBeVisible({ timeout: 30_000 });
    await mkdir(screenshots, { recursive: true });

    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(gui.locator("html")).toHaveAttribute("data-theme", theme);
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 760, height: 680 }, { width: 760, height: 420 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        await expect(editor).toBeVisible();
        await editor.fill("@");
        await gui.getByRole("tab", { name: "Agents", exact: true }).click();
        await expect(gui.getByRole("option").first()).toBeVisible();
        const expand = gui.getByRole("button", { name: "Show 10 more", exact: true });
        if (await expand.isVisible()) await expand.click();
        await expect(gui.getByRole("option")).toHaveCount(20);
        await expectWithinFrame(panel);
        const crowded = await frameRect(panel);
        expect(crowded.height).toBeLessThanOrEqual(321);
        const scroll = gui.locator(".agent-gui-node__mention-palette-scroll-region");
        await expect.poll(() => scroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
        await gui.getByRole("option").first().hover();
        await editor.press("ArrowUp");
        await expect(gui.getByRole("option").last()).toBeInViewport();
        await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

        await editor.fill("@NO_SUCH_AGENT");
        await gui.getByRole("tab", { name: "Agents", exact: true }).click();
        await expect(gui.getByRole("option")).toHaveCount(0);
        await expect(gui.locator(".rich-text-at-mention-palette__group-empty")).toBeVisible();
        await expectWithinFrame(panel);

        await editor.fill("@Design");
        await gui.getByRole("tab", { name: "Agents", exact: true }).click();
        const option = gui.getByRole("option").filter({ hasText: design.name });
        await expect(option).toBeVisible();
        await expect(gui.getByRole("option")).toHaveCount(1);
        const compact = await frameRect(panel);
        const input = await frameRect(area);
        expect(compact.height).toBeLessThan(220);
        expect(compact.bottom).toBeLessThanOrEqual(input.top - 3);
        await expectWithinFrame(panel);
        await expectWithinFrame(gui.getByRole("button", { name: "Model", exact: true }));
        await expectWithinFrame(gui.getByRole("button", { name: "Agent", exact: true }));
        await expect(option.locator(".rich-text-at-mention-row__app-name")).toHaveCSS("font-size", "13px");
        await expect(option.locator(".rich-text-at-mention-row__app-description")).toHaveCSS("font-size", "12px");
        await expect(gui.getByRole("button", { name: /folder/i })).toHaveCount(0);
        await page.screenshot({ path: `${screenshots}/after-${theme}-${viewport.width}x${viewport.height}-mentions.png`, animations: "disabled" });
        const indicator = await frameRect(gui.locator('[data-slot="underline-tabs-indicator"]'));
        const activeTab = await frameRect(gui.getByRole("tab", { name: "Agents", exact: true }));
        expect(Math.abs(indicator.left - activeTab.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(indicator.width - activeTab.width)).toBeLessThanOrEqual(1);
        await option.click();
        await expect(editor).toContainText(design.name);
        const color = await editor.locator('[data-slot="mention-pill"]').first().evaluate((element) => {
          const probe = document.createElement("span");
          probe.style.color = "var(--brand)";
          element.append(probe);
          const expected = getComputedStyle(probe).color;
          probe.remove();
          return { expected, actual: getComputedStyle(element).color };
        });
        expect(color.actual).toBe(color.expected);
        await editor.fill("A detailed interface review\n".repeat(14));
        await expect.poll(() => area.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(56);
        const coverage = await gui.getByTestId("agent-gui-composer-input-shell").evaluate((element) => ({
          surfaceTop: element.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(element, "::before").top),
          editorTop: element.querySelector(".agent-gui-node__composer-prompt-input-area")!.getBoundingClientRect().top,
        }));
        expect(coverage.surfaceTop).toBeLessThanOrEqual(coverage.editorTop + 1);
        await expectWithinFrame(gui.getByTestId("agent-gui-composer-send"));
        await editor.press("End");
        await editor.pressSequentially(" @Design");
        await gui.getByRole("tab", { name: "Agents", exact: true }).click();
        await expect(option).toBeVisible();
        expect((await frameRect(panel)).bottom).toBeLessThanOrEqual((await frameRect(area)).top - 3);
        await editor.press("Escape");
        await page.screenshot({ path: `${screenshots}/after-${theme}-${viewport.width}x${viewport.height}-draft.png`, animations: "disabled" });
        await editor.fill("");
        expect(await gui.locator("body").evaluate((body) => body.scrollWidth <= innerWidth + 1)).toBe(true);
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      expect(await gui.getByTestId("agent-gui-composer-input-shell").evaluate((element) => getComputedStyle(element, "::before").transitionDuration)).toBe("0s");
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "no-preference" });
      await page.screenshot({ path: `${screenshots}/after-${theme}-conversation.png` });
    }
    await page.goto(`/${workspace.slug}/conversations?agent=${root.id}`);
    await expect(gui.locator(".agent-gui-node__empty-hero")).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => gui.locator("body").evaluate(() => performance.getEntriesByType("resource")
      .some((entry) => entry.name.includes("codex-vinyl")))).toBe(true);
    await page.screenshot({ path: `${screenshots}/06-after-home.png`, animations: "disabled" });
  } finally {
    await database.end();
    await api.cleanup();
    await api.deleteWorkspace();
  }
});
