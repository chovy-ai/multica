import { expect, test } from "@playwright/test";
import "./env";

test("drag handles reorder the authoritative queue in main and Side", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/tutti-agent-gui/direct.html?queueReorder");
  await page.locator("#toggle").click();
  for (const theme of ["light", "dark"]) {
    if (theme === "dark") await page.locator("#theme").click();
    const main = page.locator('[data-instance="main-conversation"]');
    const side = page.locator('[data-instance="side-conversation"]');
    const panel = main.getByTestId("agent-gui-composer-queued-prompts");
    const rows = panel.locator("[data-prompt-id][data-reorderable]");
    await expect(rows).toHaveCount(3);
    await panel.locator(".agent-gui-node__composer-queued-prompt-header").click();
    const handles = panel.getByRole("button", { name: "Reorder queued message" });
    await expect(handles).toHaveCount(3);
    const handleBounds = await handles.first().boundingBox();
    const textBounds = await rows.first().locator(".agent-gui-node__composer-queued-prompt-main").boundingBox();
    expect(handleBounds!.x + handleBounds!.width).toBeLessThanOrEqual(textBounds!.x);
    await page.screenshot({ path: `.tmp/chov123/${theme}-before.png` });
    await handles.nth(2).dragTo(rows.first(), { targetPosition: { x: 80, y: 2 } });
    await expect(rows).toHaveText([/Third queued message/, /First queued message/, /Second queued message/]);
    await expect(side.locator("[data-prompt-id][data-reorderable]")).toHaveText([/First queued message/, /Second queued message/, /Third queued message/]);
    // Queue controls keep their place and the panel stays open after a move.
    await expect(handles.first()).toBeEnabled();
    await handles.first().focus();
    await page.keyboard.press("ArrowDown");
    await expect(rows).toHaveText([/First queued message/, /Third queued message/, /Second queued message/]);
    await expect(handles.nth(1)).toBeFocused();
    const reorder = await page.evaluate(() => (window as unknown as { hostActions: { method: string; params: unknown }[] }).hostActions.filter((action) => action.method === "queue.reorder").at(-1));
    expect(reorder?.params).toEqual({ sessionId: "main-conversation", requestIds: ["main-conversation-0", "main-conversation-2", "main-conversation-1"], revision: 2 });
    await page.screenshot({ path: `.tmp/chov123/${theme}-after.png` });
    await side.locator(".agent-gui-node__composer-queued-prompt-header").click();
    const sideHandles = side.getByRole("button", { name: "Reorder queued message" });
    const sideRows = side.locator("[data-prompt-id][data-reorderable]");
    await sideHandles.first().dragTo(sideRows.nth(2), { targetPosition: { x: 80, y: 28 } });
    await expect(sideRows).toHaveText([/Second queued message/, /Third queued message/, /First queued message/]);
    await expect(rows).toHaveText([/First queued message/, /Third queued message/, /Second queued message/]);
  }
  expect(errors).toEqual([]);
});
