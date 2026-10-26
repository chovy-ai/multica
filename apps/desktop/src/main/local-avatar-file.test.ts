// @vitest-environment node
import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { MAX_AVATAR_BYTES, readAvatarFile } from "./local-avatar-file";
import { LocalResourceReader } from "./local-resource-reader";

const roots: string[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh3sAAAAASUVORK5CYII=", "base64");
const signal = new AbortController().signal;
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "multica-avatar-file-")); roots.push(root);
  const cwd = join(root, "cwd"); await mkdir(cwd);
  const file = join(cwd, "avatar.png"); await writeFile(file, png);
  return { root, cwd, file };
}

it("reads an avatar from the conversation working directory without returning base64", async () => {
  const f = await fixture();
  expect(await readAvatarFile(f.file, [f.cwd], signal)).toEqual({ name: "avatar.png", mimeType: "image/png", bytes: new Uint8Array(png) });
});
it.each([
  ["avatar.JPG", "image/jpeg", Buffer.from([255, 216, 255, 224])],
  ["avatar.gif", "image/gif", Buffer.from("GIF89a")],
  ["avatar.webp", "image/webp", Buffer.from("RIFF0000WEBP")],
])("recognizes supported image headers for %s", async (name, mimeType, bytes) => {
  const f = await fixture(); const path = join(f.cwd, name); await writeFile(path, bytes);
  expect((await readAvatarFile(path, [f.cwd], signal)).mimeType).toBe(mimeType);
});
it("rejects outside paths, sibling-prefix paths, relative paths and escaping symlinks", async () => {
  const f = await fixture(); const sibling = join(f.root, "cwd-other"); await mkdir(sibling);
  const outside = join(sibling, "avatar.png"); await writeFile(outside, png);
  await expect(readAvatarFile(outside, [f.cwd], signal)).rejects.toThrow("outside");
  await expect(readAvatarFile("avatar.png", [f.cwd], signal)).rejects.toThrow("absolute");
  if (process.platform !== "win32") {
    const link = join(f.cwd, "linked.png"); await symlink(outside, link);
    await expect(readAvatarFile(link, [f.cwd], signal)).rejects.toThrow("outside");
  }
});
it("honors persisted file selections without granting sibling access", async () => {
  const f = await fixture();
  const selected = join(f.root, "selected.png"); const sibling = join(f.root, "sibling.png");
  await writeFile(selected, png); await writeFile(sibling, png);
  const preferences = join(f.root, "preferences");
  await new LocalResourceReader(preferences).approve(selected);
  const reader = new LocalResourceReader(preferences);
  expect((await reader.avatar(selected, f.cwd, signal)).bytes).toEqual(new Uint8Array(png));
  await expect(reader.avatar(sibling, f.cwd, signal)).rejects.toThrow("outside");
});
it.each([
  ["empty.png", Buffer.alloc(0), "nonempty"],
  ["renamed.png", Buffer.from("secret text"), "content"],
  ["wrong.jpg", png, "content"],
  ["vector.svg", Buffer.from("<svg/>"), "PNG"],
])("rejects invalid avatar %s", async (name, bytes, message) => {
  const f = await fixture(); const path = join(f.cwd, name); await writeFile(path, bytes);
  await expect(readAvatarFile(path, [f.cwd], signal)).rejects.toThrow(message);
});
it("rejects oversized images and directories before upload, and respects cancellation", async () => {
  const f = await fixture(); await truncate(f.file, MAX_AVATAR_BYTES + 1);
  await expect(readAvatarFile(f.file, [f.cwd], signal)).rejects.toThrow("5 MB");
  const directory = join(f.cwd, "folder.png"); await mkdir(directory);
  await expect(readAvatarFile(directory, [f.cwd], signal)).rejects.toThrow("regular");
  await expect(readAvatarFile(f.file, [f.cwd], AbortSignal.abort())).rejects.toThrow();
});
