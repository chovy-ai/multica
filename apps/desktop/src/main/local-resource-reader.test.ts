// @vitest-environment node
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LocalResourceReader } from "./local-resource-reader";
const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });
it("resolves a link outside an empty conversation directory only after explicit selection", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "multica-link-resource-"))); cleanup.push(root);
  const cwd = join(root, "session"), project = join(root, "project");
  await mkdir(cwd); await mkdir(project);
  const path = join(project, "runtime_mcp.go"); await writeFile(path, "package daemon");
  const reader = new LocalResourceReader(join(root, "preferences"));
  await expect(reader.readLink(path, cwd)).rejects.toThrow("Choose this folder");
  await reader.approve(path);
  expect(await reader.readLink(path, cwd)).toMatchObject({ root: path, path, text: "package daemon" });
  await writeFile(join(project, "sibling.go"), "package daemon");
  await expect(reader.readLink(join(project, "sibling.go"), cwd)).rejects.toThrow("Choose this folder");
  await expect(new LocalResourceReader(join(root, "other-account")).readLink(path, cwd)).rejects.toThrow("Choose this folder");
  await symlink(project, join(cwd, "escape"));
  await expect(reader.readLink(join(cwd, "escape/sibling.go"), cwd)).rejects.toThrow("Choose this folder");
  await reader.approve(project);
  expect(await reader.readLink(path, cwd)).toMatchObject({ path, text: "package daemon" });
});
it("only previews approved roots or the source working directory, including after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "multica-resource-")); cleanup.push(root);
  const folder = join(root, "project"), other = join(root, "other"); await mkdir(folder); await mkdir(other);
  await writeFile(join(folder, "test.ts"), "export const ready = true;"); await writeFile(join(other, "secret"), "outside");
  await symlink(other, join(folder, "escape"));
  const reader = new LocalResourceReader(join(root, "preferences"));
  await expect(reader.read(folder, "test.ts")).rejects.toThrow("Choose this folder");
  expect((await reader.read(folder, "test.ts", folder)).text).toContain("ready");
  const location = await reader.approve(folder);
  expect(await reader.list(location.root, location.path)).toHaveLength(1);
  await expect(reader.read(folder, "../other/secret")).rejects.toThrow("outside");
  await expect(reader.read(folder, "escape/secret")).rejects.toThrow("outside");
  expect((await new LocalResourceReader(join(root, "preferences")).read(folder, "test.ts")).text).toContain("ready");
  await expect(new LocalResourceReader(join(root, "other-account")).read(folder, "test.ts")).rejects.toThrow("Choose this folder");
});
it("returns image data, rejects binary files and caps text previews", async () => {
  const root = await mkdtemp(join(tmpdir(), "multica-resource-")); cleanup.push(root);
  const reader = new LocalResourceReader(join(root, "preferences")); await reader.approve(root);
  await writeFile(join(root, "diagram.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  expect(await reader.read(root, "diagram.svg")).toMatchObject({ mimeType: "image/svg+xml", truncated: false, data: expect.any(String) });
  await writeFile(join(root, "binary.dat"), Buffer.from([0, 1, 2])); await expect(reader.read(root, "binary.dat")).rejects.toThrow("binary format");
  await writeFile(join(root, "long.txt"), "x".repeat(1024 * 1024 + 1));
  const file = await reader.read(root, "long.txt"); expect(file.truncated).toBe(true); expect(file.text).toHaveLength(1024 * 1024);
});
it("a file selection grants only that file, not its sibling files", async () => {
  const root = await mkdtemp(join(tmpdir(), "multica-file-resource-")); cleanup.push(root);
  await writeFile(join(root, "selected.txt"), "selected");
  await writeFile(join(root, "sibling.txt"), "sibling");
  const reader = new LocalResourceReader(join(root, "preferences"));
  const location = await reader.approve(join(root, "selected.txt"));
  expect((await reader.read(location.root, location.path)).text).toBe("selected");
  await expect(reader.read(root, "sibling.txt")).rejects.toThrow("Choose this folder");
});
