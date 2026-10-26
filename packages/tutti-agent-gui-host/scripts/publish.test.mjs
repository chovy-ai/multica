import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { publishAgentGuiBuild } from "./publish.mjs";

test("keeps resources requested by an open window after publishing a new build", async () => {
  const root = await mkdtemp(join(tmpdir(), "multica-gui-publish-"));
  const source = join(root, "build"), target = join(root, "public");
  try {
    await mkdir(join(source, "assets"), { recursive: true });
    await writeFile(join(source, "index.html"), '<script src="assets/old.js"></script>');
    await writeFile(join(source, "assets/old.js"), 'export const icon = "provider-rail-codex-hash.png";');
    await writeFile(join(source, "assets/provider-rail-codex-hash.png"), "owned image bytes");
    await publishAgentGuiBuild(source, target);
    await rm(source, { recursive: true });
    await mkdir(join(source, "assets"), { recursive: true });
    await writeFile(join(source, "index.html"), '<script src="assets/new.js"></script>');
    await writeFile(join(source, "assets/new.js"), 'export const icon = "codex-rounded-hash.png";');
    await writeFile(join(source, "assets/codex-rounded-hash.png"), "owned image bytes");
    await publishAgentGuiBuild(source, target);
    assert.match(await readFile(join(target, "index.html"), "utf8"), /new\.js/);
    assert.match(await readFile(join(target, "assets/new.js"), "utf8"), /codex-rounded/);
    assert.match(await readFile(join(target, "assets/old.js"), "utf8"), /provider-rail-codex/);
    assert.equal(await readFile(join(target, "assets/provider-rail-codex-hash.png"), "utf8"), "owned image bytes");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("leaves the previous entry and assets available when the new entry is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "multica-gui-publish-"));
  const source = join(root, "build"), target = join(root, "public");
  try {
    await mkdir(source); await mkdir(target);
    await writeFile(join(target, "index.html"), "previous working entry");
    await writeFile(join(target, "old.png"), "previous working image");
    await assert.rejects(publishAgentGuiBuild(source, target));
    assert.equal(await readFile(join(target, "index.html"), "utf8"), "previous working entry");
    assert.equal(await readFile(join(target, "old.png"), "utf8"), "previous working image");
  } finally { await rm(root, { recursive: true, force: true }); }
});
