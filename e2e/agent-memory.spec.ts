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
      await expect(
        page.getByRole("tree", { name: "Memory files", exact: true }),
      ).toBeVisible();
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
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Delete", exact: true })
        .click();
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

test("long memory keeps save visible, preserves search expansion and renders Chinese dates", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(
    "/e2e/fixtures/agent-memory.html?scenario=long&theme=dark&locale=zh-Hans",
  );
  const feedback = page.getByRole("treeitem", {
    name: "feedback",
    exact: true,
  });
  await feedback.click();
  await page.getByRole("textbox", { name: "搜索记忆" }).fill("Latency");
  await expect(
    page.getByRole("button", { name: /Latency diagnostics/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "清除搜索", exact: true }).click();
  await expect(feedback).toHaveAttribute("aria-expanded", "false");
  await feedback.click();
  await page
    .getByRole("treeitem", { name: "root-cause-first.md", exact: true })
    .click();
  await expect(page.locator("time")).toContainText("2026年11月14日");
  const save = page.getByRole("button", { name: "保存", exact: true });
  const bounds = await save.boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(720);
  await page
    .getByRole("textbox", { name: "正文", exact: true })
    .fill("## 已验证\n\n记录原因和处理方式。");
  await save.click();
  await expect(page.getByRole("status")).toHaveText("已保存");
  await page.screenshot({ path: ".tmp/agent-memory/dark-1280-zh-entry.png" });
});

for (const scenario of ["empty", "failure", "loading", "readonly"] as const) {
  test(`memory state: ${scenario}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 720 });
    await page.goto(`/e2e/fixtures/agent-memory.html?scenario=${scenario}`);
    if (scenario === "empty") {
      await expect(page.getByText(/No memory yet/)).toBeVisible();
      await expect(
        page.getByRole("treeitem", { name: "MEMORY.md", exact: true }),
      ).toBeVisible();
    } else if (scenario === "failure") {
      await expect(page.getByRole("alert")).toContainText(
        "Could not access memory",
      );
      await expect(
        page.getByRole("button", { name: "Retry", exact: true }),
      ).toBeVisible();
    } else if (scenario === "loading") {
      await expect(
        page.getByRole("status", { name: "Loading...", exact: true }),
      ).toBeVisible();
    } else {
      await page
        .getByRole("treeitem", { name: "root-cause-first.md", exact: true })
        .click();
      await expect(page.getByText("Read only", { exact: true })).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: "Title", exact: true }),
      ).toHaveAttribute("readonly");
      await expect(
        page.getByRole("button", { name: "Save", exact: true }),
      ).toHaveCount(0);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `.tmp/agent-memory/light-390-${scenario}.png`,
    });
  });
}

test("saving feedback blocks duplicate submissions and failed edits can be retried", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/agent-memory.html?scenario=slow-save");
  await page
    .getByRole("treeitem", { name: "root-cause-first.md", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Title", exact: true })
    .fill("Save this once");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Saving...", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("status")).toHaveText("Saved");
  await page.goto("/e2e/fixtures/agent-memory.html?scenario=save-failure");
  await page
    .getByRole("treeitem", { name: "root-cause-first.md", exact: true })
    .click();
  const title = page.getByRole("textbox", { name: "Title", exact: true });
  await title.fill("Keep this draft");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Could not access memory",
  );
  await expect(title).toHaveValue("Keep this draft");
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
});
