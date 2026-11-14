import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const body =
  "## Why\n\nA symptom fix can hide the original failure.\n\n## How to apply\n\nRead the relevant code, reproduce the first bad state, then explain the change.";
function memoryDocument(title = "Find the root cause first", content = body) {
  return `---\ntitle: ${title}\ndescription: Show evidence before changing code\ncreated_at: 2026-11-14T09:00:00Z\nupdated_at: 2026-11-14T09:00:00Z\nsource: CHOV-117\n---\n${content}`;
}
const editor = (page: Page) =>
  page.getByRole("textbox", { name: "Markdown document", exact: true });
async function write(page: Page, source: string, label = "Markdown document") {
  const input = page.getByRole("textbox", { name: label, exact: true });
  await input.focus();
  await input.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);
}
async function openEntry(page: Page) {
  await page
    .getByRole("treeitem", { name: "root-cause-first.md", exact: true })
    .click();
  await expect(editor(page)).toBeVisible();
}
const code = (page: Page) => page.locator(".view-lines");

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
      await openEntry(page);
      await expect(code(page)).toContainText("Find the root cause first");
      await mkdir(".tmp/agent-memory/editor", { recursive: true });
      await page.screenshot({
        path: `.tmp/agent-memory/editor/${theme}-${width}-entry.png`,
        fullPage: true,
      });
      await write(page, memoryDocument("Remember the verified cause"));
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
      await expect(code(page)).toContainText("Remember the verified cause");
      await page
        .getByRole("textbox", { name: "Search memory", exact: true })
        .fill("Latency");
      await page.getByRole("button", { name: /Latency diagnostics/ }).click();
      await expect(code(page)).toContainText("Latency diagnostics");
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
  await openEntry(page);
  await write(page, memoryDocument("Local draft"));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(code(page)).toContainText("Updated by another run");
  await expect(page.locator("[role=alert]:not(.monaco-alert)")).toContainText(
    "The latest content has been loaded",
  );
});

test("memory file tree keeps hierarchy, folder icons, keyboard navigation and approved selection", async ({
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
  const icon = await feedback
    .locator('[data-item-section="content"]')
    .evaluate((e) => getComputedStyle(e, "::before").maskImage);
  expect(icon).toContain("data:image/svg+xml");
  await feedback.click();
  await expect(rootCause).toBeHidden();
  await feedback.press("ArrowRight");
  await expect(rootCause).toBeVisible();
  await openEntry(page);
  await write(page, memoryDocument("Unsaved draft"));
  await page.getByRole("treeitem", { name: "checks.md", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(rootCause).toHaveAttribute("aria-selected", "true");
  await expect(code(page)).toContainText("Unsaved draft");
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
});

test("long documents keep save visible and preserve search expansion", async ({
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
  await expect(
    page.getByRole("textbox", { name: "Markdown 文档", exact: true }),
  ).toBeVisible();
  const save = page.getByRole("button", { name: "保存", exact: true });
  const bounds = await save.boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(720);
  await write(
    page,
    memoryDocument("已验证", "## 已验证\n\n记录原因和处理方式。"),
    "Markdown 文档",
  );
  await save.click();
  await expect(page.getByRole("status")).toHaveText("已保存");
});

for (const scenario of ["empty", "failure", "loading", "readonly"] as const) {
  test(`memory state: ${scenario}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 720 });
    await page.goto(`/e2e/fixtures/agent-memory.html?scenario=${scenario}`);
    if (scenario === "empty")
      await expect(page.getByText(/No memory yet/)).toBeVisible();
    else if (scenario === "failure") {
      await expect(
        page.locator("[role=alert]:not(.monaco-alert)"),
      ).toContainText("Could not access memory");
      await expect(
        page.getByRole("button", { name: "Retry", exact: true }),
      ).toBeVisible();
    } else if (scenario === "loading")
      await expect(
        page.getByRole("status", { name: "Loading...", exact: true }),
      ).toBeVisible();
    else {
      await openEntry(page);
      await expect(page.getByText("Read only", { exact: true })).toBeVisible();
      await write(page, "cannot overwrite");
      await expect(code(page)).toContainText("Find the root cause first");
      await expect(
        page.getByRole("button", { name: "Save", exact: true }),
      ).toHaveCount(0);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("saving blocks duplicate submissions and failed drafts can be retried", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/agent-memory.html?scenario=slow-save");
  await openEntry(page);
  await write(page, memoryDocument("Save this once"));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Saving...", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("status")).toHaveText("Saved");
  await page.goto("/e2e/fixtures/agent-memory.html?scenario=save-failure");
  await openEntry(page);
  await write(page, memoryDocument("Keep this draft"));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[role=alert]:not(.monaco-alert)")).toContainText(
    "Could not access memory",
  );
  await expect(code(page)).toContainText("Keep this draft");
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
});

test("Monaco diagnostics underline errors, navigate to their line, and allow warning-only saves", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/agent-memory.html?theme=dark");
  await openEntry(page);
  await write(page, memoryDocument().replace("description:", "description"));
  const problems = page.getByRole("region", { name: "Problems" });
  await expect(problems).toContainText("Add a colon after description");
  await expect(problems).toContainText("Ln 3, Col 1");
  await expect(page.locator(".squiggly-error").first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".view-lines")).not.toContainText("Add a colon");
  await problems.getByRole("button", { name: /Add a colon/ }).click();
  await expect(editor(page)).toBeFocused();
  await expect(
    page.getByText("Ln 3, Col 1", { exact: true }).last(),
  ).toBeVisible();
  await page.screenshot({
    path: ".tmp/agent-memory/editor/dark-diagnostics.png",
  });
  await write(page, memoryDocument("Valid warning", "x".repeat(2050)));
  await expect(page.locator(".squiggly-error")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
  await editor(page).press("ControlOrMeta+s");
  await expect(page.getByRole("status")).toHaveText("Saved");
});

test("preview and file switches retain full-document edits and unknown YAML fields", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/agent-memory.html");
  await openEntry(page);
  const source = memoryDocument("Full document").replace(
    "\n---\n##",
    "\ncustom: retained\n---\n##",
  );
  await write(page, source);
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Full document", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Edit", exact: true }).click();
  await expect(code(page)).toContainText("custom: retained");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  await page.getByRole("treeitem", { name: "checks.md", exact: true }).click();
  await openEntry(page);
  await expect(code(page)).toContainText("custom: retained");
  await expect(code(page)).toContainText("updated_at: 2026-11-14T09:00:01Z");
});
