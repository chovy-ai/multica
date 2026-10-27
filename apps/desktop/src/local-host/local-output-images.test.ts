// @vitest-environment node
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { discoverCodexOutputImages, inlineOutputImages } from "./local-output-images";
import type { LocalConversation } from "@multica/core/local-conversation/protocol";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it("recovers only this native session's generated files and binds each image to its actual turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "multica-output-images-")); roots.push(root);
  const id = "11111111-1111-4111-8111-111111111111", folder = join(root, "generated_images", id);
  await mkdir(folder, { recursive: true });
  const at = Date.now() - 10_000;
  const entry = { provider: "codex", providerSessionId: id, turns: [
    { id: "first", createdAt: new Date(at).toISOString(), completedAt: new Date(at + 2000).toISOString() },
    { id: "second", createdAt: new Date(at + 5000).toISOString(), completedAt: new Date(at + 9000).toISOString() },
  ] } as LocalConversation;
  for (const [name, time] of [["first.png", at + 1000], ["second.png", at + 6000], ["outside.png", at - 1000]] as const) {
    await writeFile(join(folder, name), "image bytes"); await utimes(join(folder, name), time / 1000, time / 1000);
  }
  await writeFile(join(root, "private.png"), "private"); await symlink(join(root, "private.png"), join(folder, "escape.png"));
  expect(await discoverCodexOutputImages(entry, root)).toEqual([
    expect.objectContaining({ turnId: "first", name: "first.png", mimeType: "image/png" }),
    expect.objectContaining({ turnId: "second", name: "second.png", mimeType: "image/png" }),
  ]);
  expect(await discoverCodexOutputImages({ ...entry, providerSessionId: "../../private" }, root)).toEqual([]);
  expect(await discoverCodexOutputImages({ ...entry, provider: "claude" }, root)).toEqual([]);
});
it("recognizes structured output images without treating prose or remote URLs as image bytes", () => {
  expect(inlineOutputImages([{ type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } }, { type: "image", mimeType: "image/jpeg", data: "aW1hZ2U=" }])).toHaveLength(2);
  expect(inlineOutputImages([{ type: "input_image", image_url: "data:image/webp;base64,aW1hZ2U=" }])).toHaveLength(1);
  expect(inlineOutputImages([{ type: "text", text: "image.png" }, { type: "input_image", image_url: "https://private.example/image.png" }, { type: "image", mimeType: "text/html", data: "secret" }])).toEqual([]);
});
