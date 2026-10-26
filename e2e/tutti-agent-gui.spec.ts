import "./env";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import pg from "pg";
import { createTestApi } from "./helpers";
import type { TestApiClient } from "./fixtures";

const databaseUrl = process.env.DATABASE_URL
  ?? "postgres://multica:multica@localhost:5432/multica?sslmode=disable";

async function nativeAppearance(page: Page) {
  return page.locator("body").evaluate((body) => {
    const appearance = (element: Element) => {
      const style = getComputedStyle(element);
      return { fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight,
        color: style.color, backgroundColor: style.backgroundColor, borderRadius: style.borderRadius };
    };
    const sidebar = body.querySelector('[data-slot="sidebar-menu-button"]');
    return { body: appearance(body), sidebar: sidebar ? appearance(sidebar) : null };
  });
}

async function tokenColor(body: Locator, token: string) {
  return body.evaluate((element, name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    element.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

async function matchesNativeColor(locator: Locator, property: "color" | "backgroundColor" | "borderTopColor", parentBody: Locator, token: string) {
  const expected = await tokenColor(parentBody, token);
  await expect.poll(() => locator.evaluate((element, name) => getComputedStyle(element)[name], property)).toBe(expected);
}

async function withinFrame(locator: Locator) {
  const box = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
  });
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  expect(box.left).toBeGreaterThanOrEqual(-1);
  expect(box.top).toBeGreaterThanOrEqual(-1);
  expect(box.right).toBeLessThanOrEqual(box.viewportWidth + 1);
  expect(box.bottom).toBeLessThanOrEqual(box.viewportHeight + 1);
}

test("runs the Codex conversation flow while preserving native Chat", async ({ page: nativePage, context }) => {
  let page = nativePage;
  test.setTimeout(90_000);
  const api: TestApiClient = await createTestApi();
  const database = new pg.Client(databaseUrl);
  await database.connect();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const workspace = await api.ensureWorkspace();
    const runtimeId = await api.seedRuntime("Codex GUI test runtime", "codex");
    const agent = await api.createAgent("Codex", runtimeId);
    const secondRuntimeId = await api.seedRuntime("Second GUI test runtime", "codex");
    const secondAgent = await api.createAgent("Second Codex", secondRuntimeId);
    // Only these test-owned, unconnected runtimes get synthetic catalogs.
    await context.route(new RegExp(`/api/runtimes/(${runtimeId}|${secondRuntimeId})/models(?:\\?.*)?$`), async (route) => {
      const second = route.request().url().includes(secondRuntimeId);
      await route.fulfill({ json: {
        id: second ? "test-catalog-beta" : "test-catalog-alpha",
        runtime_id: second ? secondRuntimeId : runtimeId,
        status: "completed", supported: true,
        models: [{ id: second ? "gui-model-beta" : "gui-model-alpha", label: second ? "GUI Model Beta" : "GUI Model Alpha" }],
      } });
    });
    const issue = await api.createIssue("Review the original GUI report", { status: "backlog" });
    const user = await database.query<{ id: string }>('SELECT id FROM "user" WHERE email=$1', [api.getEmail()]);
    const sessionIds: string[] = [];
    for (const [title, reply] of [
      ["Original GUI history", "SOURCE_GUI_HISTORY_OUTPUT"],
      ["Second GUI conversation", "SOURCE_GUI_SECOND_OUTPUT"],
    ]) {
      const session = await database.query<{ id: string }>(
        "INSERT INTO chat_session (workspace_id, agent_id, creator_id, title, status) VALUES ($1,$2,$3,$4,'active') RETURNING id",
        [workspace.id, agent.id, user.rows[0]!.id, title],
      );
      sessionIds.push(session.rows[0]!.id);
      await database.query(
        "INSERT INTO chat_message (chat_session_id,role,content,created_at) VALUES ($1,'user','Read the saved report',now()-interval '1 second'),($1,'assistant',$2,now())",
        [session.rows[0]!.id, `${reply}\n\n[${issue.identifier}](mention://issue/${issue.id})\n\n\`\`\`ts\nconst sourceGui = true;\n\`\`\``],
      );
    }
    await context.addInitScript((token) => {
      if (window !== window.top) return;
      localStorage.setItem("multica_token", token!);
      localStorage.setItem("multica:chat:isOpen", "false");
    }, api.getToken());
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/${workspace.slug}/agents`);
    await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
    await page.goto(`/${workspace.slug}/chat?session=${sessionIds[0]}`);
    await expect(page.getByText("SOURCE_GUI_HISTORY_OUTPUT", { exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const nativeBefore = await nativeAppearance(nativePage);
    expect(nativeBefore.body.fontFamily).toMatch(/Inter/i);
    await expect(page.getByRole("link", { name: "Agent workspace", exact: true })).toHaveCount(0);
    const opened = context.waitForEvent("page");
    await page.getByRole("link", { name: "Conversations", exact: true }).click();
    page = await opened;
    await page.bringToFront();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(page).toHaveURL(new RegExp(`/${workspace.slug}/conversations$`));
    const iframe = page.getByTestId("tutti-agent-gui-host").locator("iframe");
    await expect(iframe).toBeVisible({ timeout: 30_000 });
    await expect(iframe).toHaveAttribute("src", /\/tutti-agent-gui\/index\.html/);
    expect(await iframe.getAttribute("src")).not.toMatch(/token|Bearer|jwt/i);
    const gui = page.frameLocator('[data-testid="tutti-agent-gui-host"] iframe');
    await expect(gui.locator(".agent-gui-node__layout")).toBeVisible({ timeout: 30_000 });
    await expect(gui.locator(".agent-gui-node__layout")).toHaveAttribute("data-agent-gui-active", "true");
    const list = page.getByTestId("conversation-flow-sessions");
    const detail = page.getByTestId("conversation-flow-detail");
    const first = list.locator('[tabindex="0"]').filter({ has: page.getByText("Original GUI history", { exact: true }) });
    const second = list.locator('[tabindex="0"]').filter({ has: page.getByText("Second GUI conversation", { exact: true }) });
    await expect(first).toBeVisible({ timeout: 10_000 });
    await first.click();
    await expect(gui.getByText("SOURCE_GUI_HISTORY_OUTPUT", { exact: true })).toBeVisible();
    await expect(gui.locator(".agent-gui-node__provider-rail-panel")).toBeHidden();
    await expect(gui.locator(".agent-gui-node__rail")).toBeHidden();
    await expect(page.locator(".agent-gui-node__layout")).toHaveCount(0);
    expect((await nativeAppearance(page)).body.fontFamily).toMatch(/Inter/i);
    const guiFont = await gui.locator("body").evaluate((body) => getComputedStyle(body).fontFamily);
    expect(guiFont).toMatch(/Inter/i);
    expect(guiFont).toMatch(/PingFang|Hiragino|Noto Sans CJK|Microsoft YaHei/i);
    await expect(gui.locator("body")).toHaveCSS("font-size", "14px");
    await expect(gui.locator("body")).toHaveCSS("line-height", "20px");
    const code = gui.locator("pre code").filter({ hasText: "const sourceGui = true;" }).first();
    await expect(code).toBeVisible();
    expect(await code.evaluate((element) => getComputedStyle(element).fontFamily)).toMatch(/Geist Mono/i);
    await gui.locator("body").evaluate(() => document.fonts.ready);
    expect(await gui.locator("body").evaluate(() => [...document.fonts].some((font) => /Inter/i.test(font.family) && font.status === "loaded"))).toBe(true);
    expect(await gui.locator("body").evaluate(() => [...document.fonts].some((font) => /Geist Mono/i.test(font.family) && font.status === "loaded"))).toBe(true);
    await gui.getByText(issue.identifier, { exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${workspace.slug}/issues/${issue.id}$`));
    await expect(page.getByText(issue.title, { exact: true }).first()).toBeVisible();
    await page.goBack();
    await expect(iframe).toBeVisible();
    await expect(gui.getByText("SOURCE_GUI_HISTORY_OUTPUT", { exact: true })).toBeVisible();
    const editor = gui.getByTestId("agent-gui-composer-editor");
    const modelPicker = gui.getByTestId("multica-model-picker");
    const agentPicker = gui.getByTestId("multica-agent-picker");
    const sessionSearch = list.getByRole("textbox", { name: "Search conversations", exact: true });
    const selectModel = async (name: string) => {
      await modelPicker.click();
      await gui.getByRole("menuitemradio", { name, exact: true }).click();
      await expect(modelPicker).toContainText(name);
      await expect(gui.getByRole("menu")).toBeHidden();
      await expect(modelPicker).toHaveAttribute("aria-expanded", "false");
    };
    const expectModel = async (name: string) => {
      await modelPicker.click();
      await expect(gui.getByRole("menuitemradio", { name, exact: true })).toHaveAttribute("aria-checked", "true");
      await gui.getByRole("menu").press("Escape");
      await expect(gui.getByRole("menu")).toBeHidden();
      await expect(modelPicker).toHaveAttribute("aria-expanded", "false");
    };
    const selectAgent = async (id: string, name: string) => {
      await agentPicker.click();
      await gui.getByRole("menuitemradio", { name, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`agent=${id}`));
      await expect(agentPicker).toContainText(name);
      await expect(gui.getByRole("menu")).toBeHidden();
    };
    await selectModel("GUI Model Alpha");
    await expect(modelPicker).toHaveAccessibleDescription("GUI Model Alpha");
    await expect(agentPicker).toHaveAccessibleDescription(agent.name);
    await page.reload();
    await expect(gui.getByText("SOURCE_GUI_HISTORY_OUTPUT", { exact: true })).toBeVisible();
    await expectModel("GUI Model Alpha");
    const parentBody = page.locator("body");
    const parentSidebarButton = page.locator('[data-slot="sidebar-menu-button"]').first();
    await editor.fill("UI_ALIGNMENT_DRAFT 中文输入");
    const selectedSessionUrl = page.url();
    await agentPicker.click();
    await gui.getByRole("menuitemradio", { name: agent.name, exact: true }).click();
    await expect(page).toHaveURL(selectedSessionUrl);
    await expect(editor).toContainText("UI_ALIGNMENT_DRAFT 中文输入");
    for (const colorScheme of ["dark", "light"] as const) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await expect(parentSidebarButton).toBeVisible();
      await page.emulateMedia({ colorScheme });
      await expect(page.locator("html")).toHaveClass(new RegExp(colorScheme));
      await expect(gui.locator("html")).toHaveAttribute("data-theme", colorScheme);
      if (colorScheme === "dark") await expect(gui.locator("html")).toHaveClass(/dark/);
      else await expect(gui.locator("html")).not.toHaveClass(/dark/);
      const parentBefore = await nativeAppearance(page);
      await matchesNativeColor(gui.locator("body"), "color", parentBody, "--foreground");
      await matchesNativeColor(gui.locator(".agent-gui-node__layout"), "backgroundColor", parentBody, "--app-shell");
      await matchesNativeColor(gui.locator(".agent-gui-node__detail-panel"), "backgroundColor", parentBody, "--page-canvas");
      expect(await tokenColor(gui.locator("body"), "--text-secondary")).toBe(await tokenColor(parentBody, "--muted-foreground"));
      await expect(first).toHaveAttribute("aria-current", "true");
      await matchesNativeColor(first, "backgroundColor", parentBody, "--accent");
      const selectedHeight = await first.evaluate((element) => element.getBoundingClientRect().height);
      await second.hover();
      await expect(first).toHaveAttribute("aria-current", "true");
      await expect(second).not.toHaveAttribute("aria-current", "true");
      await matchesNativeColor(first, "backgroundColor", parentBody, "--accent");
      expect(await first.evaluate((element) => element.getBoundingClientRect().height)).toBe(selectedHeight);
      await expect(first.getByText("Original GUI history", { exact: true })).toHaveCSS("font-size", "14px");
      await expect(first.getByText("Original GUI history", { exact: true })).toHaveCSS("line-height", "20px");
      const frameDocument = await editor.evaluate((element) => {
        document.body.dataset.twoPaneDocument = "retained";
        return element.ownerDocument.URL;
      });
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 1024, height: 768 }, { width: 900, height: 768 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        await expect(editor).toContainText("UI_ALIGNMENT_DRAFT 中文输入");
        await expect(editor).toHaveCSS("font-size", "14px");
        await expect(editor.locator("p").first()).toHaveCSS("font-size", "14px");
        await expect(editor).toHaveCSS("line-height", "24px");
        await expect(gui.locator(".agent-gui-node__composer[data-layout='dock'] .agent-gui-node__composer-prompt-input-area")).toHaveCSS("min-height", "56px");
        await expect(gui.locator(".agent-gui-node__provider-rail-panel")).toBeHidden();
        await expect(gui.locator(".agent-gui-node__rail")).toBeHidden();
        await expect(gui.locator(".agent-gui-node__composer-handoff-trigger")).toBeHidden();
        for (const region of [gui.locator(".agent-gui-node__detail-panel"), editor, gui.getByTestId("agent-gui-composer-send"), modelPicker, agentPicker]) await withinFrame(region);
        expect(await gui.locator("body").evaluate((body) => body.scrollWidth <= innerWidth + 1)).toBe(true);
        expect(await page.locator("body").evaluate((body) => body.scrollWidth <= innerWidth + 1)).toBe(true);
        if (viewport.width < 1024) {
          await expect(list).toBeHidden();
          await detail.getByRole("button", { name: "Sessions", exact: true }).click();
          await expect(list).toBeVisible();
          await expect(iframe).toBeHidden();
          await sessionSearch.fill("NO_SUCH_CONVERSATION");
          await expect(list.getByText("No matching conversations", { exact: true })).toBeVisible();
          await list.getByRole("button", { name: "Return to conversation", exact: true }).click();
          await expect(editor).toContainText("UI_ALIGNMENT_DRAFT 中文输入");
          await detail.getByRole("button", { name: "Sessions", exact: true }).click();
          await expect(sessionSearch).toHaveValue("NO_SUCH_CONVERSATION");
          await sessionSearch.press("Escape");
          await expect(sessionSearch).toBeFocused();
          await expect(first).toBeVisible();
          await list.getByRole("button", { name: "Return to conversation", exact: true }).click();
          await expect(list).toBeHidden();
          await expect(editor).toBeVisible();
          await expect(editor).toContainText("UI_ALIGNMENT_DRAFT 中文输入");
          await expect(gui.locator("body")).toHaveAttribute("data-two-pane-document", "retained");
          expect(await editor.evaluate((element) => element.ownerDocument.URL)).toBe(frameDocument);
          await expect.poll(() => detail.evaluate((element) => element.querySelector("iframe")!.getBoundingClientRect().top - element.getBoundingClientRect().top)).toBe(48);
        } else {
          await expect(list).toBeVisible();
          await sessionSearch.fill("Second GUI");
          await expect(second).toBeVisible();
          await expect(first).toBeHidden();
          await expect(editor).toContainText("UI_ALIGNMENT_DRAFT 中文输入");
          await sessionSearch.press("Escape");
          await expect(first).toBeVisible();
          await expect.poll(() => page.getByTestId("conversation-flow-page").evaluate((element) => {
            const listBox = element.querySelector('[data-testid="conversation-flow-sessions"]')!.getBoundingClientRect();
            const detailBox = element.querySelector('[data-testid="conversation-flow-detail"]')!.getBoundingClientRect();
            return listBox.right - detailBox.left;
          })).toBeLessThanOrEqual(1);
          await expect.poll(() => list.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(240);
        }
        await mkdir(".tmp/conversation-ui-polish", { recursive: true });
        await page.screenshot({ path: `.tmp/conversation-ui-polish/verified-${colorScheme}-${viewport.width}.png`, fullPage: true });
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      const more = detail.getByRole("button", { name: "More actions", exact: true });
      await more.focus();
      await more.press("Enter");
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      await expect(gui.getByRole("menu")).toHaveCount(0);
      await withinFrame(menu);
      await matchesNativeColor(menu, "backgroundColor", parentBody, "--surface-raised");
      await page.keyboard.press("ArrowDown");
      await expect.poll(() => menu.evaluate((element) => ({
        inside: element.contains(document.activeElement),
        role: document.activeElement?.getAttribute("role"),
        active: document.activeElement?.outerHTML,
      }))).toEqual(expect.objectContaining({ inside: true, role: "menuitem" }));
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(more).toBeFocused();
      const originalUrl = page.url();
      await more.press("Enter");
      await page.getByRole("menuitem", { name: "Rename chat", exact: true }).press("Enter");
      const renameInput = detail.getByRole("textbox", { name: "Rename chat", exact: true });
      await expect(renameInput).toHaveValue("Original GUI history");
      await renameInput.fill("THIS_TITLE_MUST_NOT_BE_SAVED");
      await renameInput.press("Escape");
      await expect(renameInput).toBeHidden();
      await expect(page).toHaveURL(originalUrl);
      await expect(first.getByText("Original GUI history", { exact: true })).toBeVisible();
      await editor.click();
      await expect(editor).toBeFocused();
      await expect(gui.locator(".agent-gui-node__layout")).toHaveAttribute("data-agent-gui-active", "true");
      await page.setViewportSize({ width: 1440, height: 1000 });
      await expect(parentSidebarButton).toBeVisible();
      expect(await nativeAppearance(page)).toEqual(parentBefore);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await editor.fill("");
    await expect(first).toBeVisible();
    await second.click();
    await expect(gui.getByText("SOURCE_GUI_SECOND_OUTPUT", { exact: true })).toBeVisible();
    await expect(gui.locator(".agent-gui-node__layout")).toHaveAttribute("data-agent-gui-active", "true");
    await expect(page).toHaveURL(new RegExp(`session=${sessionIds[1]}`));
    await expect(nativePage).toHaveURL(new RegExp(`/${workspace.slug}/chat\\?session=${sessionIds[0]}$`));
    await expect(nativePage.getByText("SOURCE_GUI_HISTORY_OUTPUT", { exact: true })).toBeVisible();
    await expect(nativePage.getByTestId("tutti-agent-gui-host")).toHaveCount(0);
    await first.click();
    await expect(gui.getByText("SOURCE_GUI_HISTORY_OUTPUT", { exact: true })).toBeVisible();

    await expect(editor).toHaveAttribute("contenteditable", "true");
    await editor.fill("@");
    await gui.getByRole("tab", { name: "Sessions", exact: true }).click();
    await gui.getByRole("option").filter({ hasText: "Second GUI conversation" }).click();
    await expect(editor).toContainText("Second GUI conversation");
    await editor.press("End");
    await editor.pressSequentially(" @");
    await gui.getByRole("tab", { name: "Tasks", exact: true }).click();
    await gui.getByRole("option").filter({ hasText: issue.identifier }).click();
    await expect(editor).toContainText(issue.identifier);
    await editor.press("End");
    await editor.pressSequentially(" SOURCE_GUI_SYNTHETIC_SEND");
    const uploaded = page.waitForResponse((response) => response.request().method() === "POST"
      && /\/api\/upload-file$/.test(response.url()));
    await editor.evaluate((target) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["A synthetic report"], "source-gui-report.txt", { type: "text/plain" }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    const upload = await uploaded;
    expect(upload.ok()).toBe(true);
    const attachment = await upload.json() as { id: string };
    const sent = page.waitForResponse((response) => response.request().method() === "POST"
      && /\/api\/chat\/sessions\/[^/]+\/messages$/.test(response.url()));
    await gui.getByTestId("agent-gui-composer-send").click();
    const accepted = await sent;
    expect(accepted.status()).toBe(201);
    expect(accepted.request().postDataJSON().attachment_ids).toEqual([attachment.id]);
    expect(accepted.request().postDataJSON().model).toBe("gui-model-alpha");
    const contextContent = accepted.request().postDataJSON().content;
    expect(contextContent).toContain("SOURCE_GUI_SECOND_OUTPUT");
    expect(contextContent).toContain(`[${issue.identifier}](mention://issue/${issue.id})`);
    expect(contextContent).not.toContain("Agent: Codex");
    await expect(gui.getByText("Referenced context (snapshot):", { exact: false })).toHaveCount(0);
    await nativePage.reload();
    await expect(nativePage.getByText("SOURCE_GUI_SYNTHETIC_SEND", { exact: false })).toBeVisible();
    await expect(nativePage.getByText("Referenced context (snapshot):", { exact: false })).toHaveCount(0);
    await page.bringToFront();
    await editor.click();
    await expect(gui.locator(".agent-gui-node__layout")).toHaveAttribute("data-agent-gui-active", "true");
    const cancelled = page.waitForResponse((response) => response.request().method() === "POST"
      && /\/api\/tasks\/[^/]+\/cancel$/.test(response.url()));
    await gui.getByTestId("agent-gui-composer-stop-active-turn").click();
    expect((await cancelled).ok()).toBe(true);
    await expect(editor).toContainText("SOURCE_GUI_SYNTHETIC_SEND");
    await expect(editor).toContainText("source-gui-report.txt");
    await expect(editor).not.toContainText("multica-context-snapshot");
    await expect(gui.getByTestId("agent-gui-composer-send")).toBeEnabled();
    const resent = page.waitForResponse((response) => response.request().method() === "POST"
      && /\/api\/chat\/sessions\/[^/]+\/messages$/.test(response.url()));
    await gui.getByTestId("agent-gui-composer-send").click();
    const acceptedRestore = await resent;
    expect(acceptedRestore.status()).toBe(201);
    expect(acceptedRestore.request().postDataJSON().attachment_ids).toEqual([attachment.id]);
    expect(acceptedRestore.request().postDataJSON().model).toBe("gui-model-alpha");
    expect(acceptedRestore.request().postDataJSON().content.match(/Referenced context \(snapshot\)/g)).toHaveLength(1);
    const cancelledRestore = page.waitForResponse((response) => response.request().method() === "POST"
      && /\/api\/tasks\/[^/]+\/cancel$/.test(response.url()));
    await gui.getByTestId("agent-gui-composer-stop-active-turn").click();
    expect((await cancelledRestore).ok()).toBe(true);
    await expect(editor).toContainText("SOURCE_GUI_SYNTHETIC_SEND");
    await expect(editor).toContainText("source-gui-report.txt");

    await selectAgent(secondAgent.id, secondAgent.name);
    await expectModel("Default");
    await expect(editor).toBeEmpty();
    await selectModel("GUI Model Beta");
    await selectAgent(agent.id, agent.name);
    await expectModel("Default");
    await selectModel("GUI Model Alpha");
    await selectAgent(secondAgent.id, secondAgent.name);
    await expectModel("GUI Model Beta");
    await selectAgent(agent.id, agent.name);
    await expectModel("GUI Model Alpha");
    await page.reload();
    await expectModel("GUI Model Alpha");
    await selectModel("Default");
    await page.reload();
    await expectModel("Default");

    const createdSession = page.waitForResponse((response) => response.request().method() === "POST"
      && /\/api\/chat\/sessions$/.test(response.url()));
    await list.getByRole("button", { name: "New conversation", exact: true }).click();
    const created = await createdSession;
    expect(created.status()).toBe(201);
    expect(created.request().postDataJSON().agent_id).toBe(agent.id);
    const newSession = await created.json() as { id: string };
    expect(sessionIds).not.toContain(newSession.id);
    await expect(page).toHaveURL(new RegExp(`session=${newSession.id}`));
    await expect(editor).toBeEmpty();
    await expectModel("Default");
    await editor.fill("CODEX_GUI_NEW_CONVERSATION");
    const firstSend = page.waitForResponse((response) => response.request().method() === "POST"
      && /\/api\/chat\/sessions\/[^/]+\/messages$/.test(response.url()));
    await gui.getByTestId("agent-gui-composer-send").click();
    const firstAccepted = await firstSend;
    expect(firstAccepted.status()).toBe(201);
    expect(firstAccepted.url()).toContain(`/sessions/${newSession.id}/messages`);
    expect(firstAccepted.request().postDataJSON()).not.toHaveProperty("model");
    const cancelNew = page.waitForResponse((response) => response.request().method() === "POST"
      && /\/api\/tasks\/[^/]+\/cancel$/.test(response.url()));
    await gui.getByTestId("agent-gui-composer-stop-active-turn").click();
    expect((await cancelNew).ok()).toBe(true);
    await expect(editor).toContainText("CODEX_GUI_NEW_CONVERSATION");
    await expect(nativePage).toHaveURL(new RegExp(`/${workspace.slug}/chat\\?session=${sessionIds[0]}$`));
    await expect(nativePage.getByText("SOURCE_GUI_HISTORY_OUTPUT", { exact: true })).toBeVisible();

    await mkdir(".tmp/multica-gui-restoration", { recursive: true });
    await page.screenshot({ path: ".tmp/multica-gui-restoration/two-pane-complete.png", fullPage: true });
    await page.getByRole("link", { name: "Agents", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
    expect(await nativeAppearance(nativePage)).toEqual(nativeBefore);
    expect(errors).toEqual([]);
  } catch (error) {
    await test.info().attach("conversation-flow-focus", { body: JSON.stringify({
      page: await page.evaluate(() => ({ focused: document.hasFocus(), visibility: document.visibilityState, activeElement: document.activeElement?.tagName })),
      gui: await page.frameLocator('[data-testid="tutti-agent-gui-host"] iframe').locator('.agent-gui-node__layout').getAttribute('data-agent-gui-active').catch(() => null),
    }), contentType: "text/plain" });
    await test.info().attach("conversation-flow-failure", { body: await page.screenshot(), contentType: "image/png" });
    await test.info().attach("conversation-flow-text", { body: await page.locator("body").innerText(), contentType: "text/plain" });
    throw error;
  } finally {
    await database.end();
    await api.cleanup();
    await api.deleteWorkspace();
  }
});
