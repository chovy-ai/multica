import "./env";
import { expect, test, type Page, type Locator } from "@playwright/test";
import { resolve } from "node:path";

async function open(page: Page, query = "") {
  const fixture = `/@fs/${resolve("apps/desktop/test/fixtures/local-conversation-sortable-list.tsx")}`;
  await page.route("**/__test/conversation-order*", (route) => route.fulfill({ contentType: "text/html", body: `<div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; await import(${JSON.stringify(fixture)});</script>` }));
  await page.goto(`/__test/conversation-order${query}`);
  await expect(page.getByRole("region", { name: "Project", exact: true })).toBeVisible();
}

async function drag(page: Page, handle: Locator, target: Locator, during?: () => Promise<void>) {
  const from = (await handle.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  try {
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 8, { steps: 2 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await during?.();
  } finally {
    await page.mouse.up();
  }
}

for (const theme of ["light", "dark"]) {
  test(`sorts with pointer and keyboard, cancels and restores in ${theme} theme`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 420, height: 840 });
    await open(page, `?theme=${theme}&baseline`);
    await page.screenshot({ path: `.tmp/chov128/${theme}-before.png` });
    await page.goto(`/__test/conversation-order?theme=${theme}`);
    const project = page.getByRole("region", { name: "Project", exact: true });
    const rows = project.locator("[data-sortable-session]");
    const order = () => rows.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-sortable-session")));
    const settled = () => expect.poll(() => rows.evaluateAll((elements) => elements.map((element) => getComputedStyle(element).transform))).toEqual(["none", "none", "none", "none"]);
    const handle = (name: string) => project.getByRole("button", { name: `Reorder conversation: ${name}`, exact: true });
    await expect(rows).toHaveCount(4);
    await drag(page, handle("Third"), rows.nth(1), async () => {
      await expect(project.locator('[data-dragging="true"]')).toHaveCount(1);
      await expect(project.locator('[data-dragging="true"]')).toHaveCSS("box-shadow", /rgb/);
      await page.screenshot({ path: `.tmp/chov128/${theme}-dragging.png` });
    });
    await expect.poll(order).toEqual(["Pinned", "Third", "First", "Second"]);
    await expect(page.getByLabel("Navigation count")).toHaveText("0");
    await page.screenshot({ path: `.tmp/chov128/${theme}-after.png` });
    // A drop on another pin partition or another folder never writes a move.
    await drag(page, handle("Second"), rows.first());
    await expect.poll(order).toEqual(["Pinned", "Third", "First", "Second"]);
    await drag(page, handle("Third"), page.getByRole("region", { name: "No project" }).locator("[data-sortable-session]").last());
    await expect.poll(order).toEqual(["Pinned", "Third", "First", "Second"]);
    await settled();
    await handle("Third").focus();
    await page.keyboard.press("Space");
    await expect(project.locator('[data-dragging="true"]')).toHaveCount(1);
    // The keyboard sensor attaches its document listener after starting the drag.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await page.keyboard.press("ArrowDown");
    await expect(project.getByRole("status")).toContainText("First");
    await page.keyboard.press("Escape");
    await expect(project.locator('[data-dragging="true"]')).toHaveCount(0);
    await expect.poll(order).toEqual(["Pinned", "Third", "First", "Second"]);
    // A cancelled sort animates rows back; start the next gesture after layout settles.
    await settled();
    await handle("Third").focus();
    await page.keyboard.press("Space");
    await expect(project.locator('[data-dragging="true"]')).toHaveCount(1);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await page.keyboard.press("ArrowDown");
    await expect(project.getByRole("status")).toContainText("First");
    await page.keyboard.press("Space");
    await expect.poll(order).toEqual(["Pinned", "First", "Third", "Second"]);
    await expect(handle("Third")).toBeFocused();
    await page.reload();
    await expect.poll(order).toEqual(["Pinned", "First", "Third", "Second"]);
    await page.goto(`/__test/conversation-order?theme=${theme}&device=other`);
    await expect.poll(order).toEqual(["Pinned", "First", "Second", "Third"]);
    await project.getByRole("button", { name: "Conversation actions：First" }).click();
    await page.getByRole("menuitem", { name: "Menu action" }).click();
    await expect(page.getByLabel("Menu result")).toHaveText("First");
    await project.locator('[data-session-id="First"] a').click();
    await expect(page.getByLabel("Navigation count")).toHaveText("1");
    expect(errors).toEqual([]);
  });
}
