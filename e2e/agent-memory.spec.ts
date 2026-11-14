import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";

for (const theme of ["light", "dark"])
  for (const width of [1280, 390]) {
    test(`agent memory management: ${theme} ${width}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.setViewportSize({ width, height: 960 });
      await page.goto(`/e2e/fixtures/agent-memory.html?theme=${theme}`);
      await expect(page.getByText("Generated · Read only")).toBeVisible();
      await page
        .getByRole("button", { name: /Find the root cause first/ })
        .click();
      const title = page.getByRole("textbox", { name: "Title", exact: true });
      await expect(title).toHaveValue("Find the root cause first");
      await mkdir(".tmp/agent-memory", { recursive: true });
      await page.screenshot({
        path: `.tmp/agent-memory/${theme}-${width}-entry.png`,
        fullPage: true,
      });
      await title.fill("Remember the verified cause");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Save", exact: true }),
      ).toBeDisabled();
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(page.getByRole("alertdialog")).toContainText("30 days");
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      await expect(page.getByRole("alertdialog")).toBeHidden();
      await page.locator("summary").filter({ hasText: "Trash" }).click();
      await page
        .getByRole("button", { name: /Remember the verified cause/ })
        .click();
      await page.getByRole("button", { name: "Restore", exact: true }).click();
      await expect(title).toHaveValue("Remember the verified cause");
      await page
        .getByRole("textbox", { name: "Search memory", exact: true })
        .fill("Latency");
      await expect(
        page.getByRole("button", { name: /Latency diagnostics/ }),
      ).toBeVisible();
      await page.getByRole("button", { name: /Latency diagnostics/ }).click();
      await expect(title).toHaveValue("Latency diagnostics");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(errors).toEqual([]);
    });
  }
test("agent memory reloads a conflicting edit", async ({ page }) => {
  await page.goto("/e2e/fixtures/agent-memory.html?scenario=conflict");
  await page.getByRole("button", { name: /Find the root cause first/ }).click();
  const title = page.getByRole("textbox", { name: "Title", exact: true });
  await title.fill("Local draft");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(title).toHaveValue("Updated by another run");
  await expect(
    page.getByText(
      "This memory was changed by the agent. The latest content has been loaded.",
    ),
  ).toBeVisible();
});
