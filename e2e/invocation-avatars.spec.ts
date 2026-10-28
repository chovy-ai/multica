import "./env";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"] as const) {
  for (const local of [true, false]) {
    test(`shows each delegated author through streaming, completion and history in ${theme} (${local ? "local" : "cloud"})`, async ({ page }) => {
      const fixture = await readFile(new URL("./fixtures/invocation-avatars.html", import.meta.url), "utf8");
      await page.route("**/__test/invocation-avatars?*", (route) => route.fulfill({ contentType: "text/html", body: fixture }));
      await page.route("**/vendor/tutti/packages/agent/gui/app/renderer/assets/icons/agents/*.png", async (route) => {
        const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
        const body = await readFile(new URL(`../vendor/tutti/packages/agent/gui/app/renderer/assets/icons/agents/${name}`, import.meta.url));
        await route.fulfill({ contentType: "image/png", body });
      });
      await page.goto(`/__test/invocation-avatars?theme=${theme}&local=${local}&streaming`);
      const frame = page.frameLocator("iframe");
      const headers = frame.locator("[data-invoked-agent]");
      await expect(headers).toHaveCount(2);
      const first = frame.locator('[data-invoked-agent="agent-0"]');
      const second = frame.locator('[data-invoked-agent="agent-1"]');
      await expect(first).toHaveText("团团用例平台队长");
      await expect(second).toHaveText("锤锤审查发布官");
      await expect(first.getByRole("img")).toHaveAttribute("src", /claude-rounded/);
      await expect(second.getByRole("img")).toHaveAttribute("src", /gemini-rounded/);
      await expect.poll(() => headers.locator("img").evaluateAll((images) => images.every((image) => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
      const geometry = await first.evaluate((header) => {
        const avatar = header.querySelector('[data-slot="avatar"]')!.getBoundingClientRect();
        const name = header.querySelector("span[title]")!.getBoundingClientRect();
        return { before: avatar.right <= name.left, aligned: Math.abs(avatar.y + avatar.height / 2 - name.y - name.height / 2) < 2 };
      });
      expect(geometry).toEqual({ before: true, aligned: true });

      await page.evaluate(() => (window as unknown as { finishInvocation(): void }).finishInvocation());
      await expect(frame.getByRole("button", { name: "复制消息", exact: true })).toHaveCount(3);
      await expect(headers).toHaveCount(2);
      await expect(frame.locator("strong")).toHaveText("测试用例平台");
      await expect(frame.locator("code")).toHaveText("review");

      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await second.hover();
      await frame.getByRole("button", { name: "复制消息", exact: true }).nth(2).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("收到，后续创建任务一律归入测试用例平台项目。`review` 已完成。");
      await page.reload();
      await expect(headers).toHaveCount(2);
      await expect(second.getByRole("img")).toHaveAttribute("src", /gemini-rounded/);
      await page.evaluate(() => (window as unknown as { breakAvatar(): void }).breakAvatar());
      await expect(second.locator("img")).toHaveCount(0);
      await expect(second.locator("svg")).toBeVisible();
      await page.evaluate(() => (window as unknown as { removeAvatar(): void }).removeAvatar());
      await expect(second.locator("img")).toHaveCount(0);
      await expect(second.locator("svg")).toBeVisible();
      await page.evaluate(() => (window as unknown as { removeAgent(): void }).removeAgent());
      await expect(second).toHaveText("锤锤审查发布官");
      await expect(second.locator("svg")).toBeVisible();
    });
  }
}
