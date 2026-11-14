import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";

for (const theme of ["light", "dark"])
  for (const width of [1280, 390]) {
    test(`agent memory management: ${theme} ${width}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.setViewportSize({ width, height: 960 });
      await page.goto(`/e2e/fixtures/agent-memory.html?theme=${theme}`);
      await expect(
        page.getByRole("treeitem", { name: "MEMORY.md", exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTitle("Generated · Read only")).toBeAttached();
      await page
        .getByRole("treeitem", { name: "root-cause-first.md", exact: true })
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
      await page.getByRole("treeitem", { name: ".trash", exact: true }).click();
      await page
        .getByRole("treeitem", { name: "20261114T090000Z", exact: true })
        .click();
      await page
        .locator('[data-item-path=".trash/20261114T090000Z/feedback/"]')
        .click();
      await page
        .locator(
          '[data-item-path=".trash/20261114T090000Z/feedback/root-cause-first.md"]',
        )
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
  await page
    .getByRole("treeitem", { name: "root-cause-first.md", exact: true })
    .click();
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

test("memory file tree keeps directories, keyboard navigation and approved selection", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/agent-memory.html?theme=dark");
  const index = page.getByRole("treeitem", { name: "MEMORY.md", exact: true });
  const feedback = page.getByRole("treeitem", {
    name: "feedback",
    exact: true,
  });
  const rootCause = page.getByRole("treeitem", {
    name: "root-cause-first.md",
    exact: true,
  });
  await expect(rootCause).toHaveAttribute("aria-level", "2");
  await expect(
    page.getByRole("treeitem", { name: "checks.md", exact: true }),
  ).toHaveAttribute("aria-level", "3");
  await expect(
    page.getByRole("treeitem", { name: ".trash", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await feedback.click();
  await expect(rootCause).toBeHidden();
  await feedback.press("ArrowRight");
  await expect(rootCause).toBeVisible();
  await rootCause.click();
  await page
    .getByRole("textbox", { name: "Title", exact: true })
    .fill("Unsaved draft");
  await page.getByRole("treeitem", { name: "checks.md", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(rootCause).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("textbox", { name: "Title", exact: true }),
  ).toHaveValue("Unsaved draft");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await rootCause.focus();
  await rootCause.press("ArrowUp");
  await expect(feedback).toBeFocused();
  await feedback.press("ArrowUp");
  await expect(index).toBeFocused();
  await index.press("Enter");
  await expect(index).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("textbox", { name: "Body", exact: true }),
  ).toHaveCount(0);
});
