// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateLegacyData, MIGRATED_MARKER } from "./legacy-migration";

const scopeKey = "a".repeat(64);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function legacyDir(sessions: { id: string; updatedAt: string; title: string }[], extra: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "multica-legacy-")); roots.push(root);
  await mkdir(join(root, scopeKey, "files"), { recursive: true });
  await mkdir(join(root, scopeKey, "workdirs", "conv"), { recursive: true });
  await writeFile(join(root, scopeKey, "conversations.json"), JSON.stringify({ schemaVersion: 1, sessions, folderProjects: [{ id: "p1" }] }));
  await writeFile(join(root, scopeKey, "preview-roots.json"), JSON.stringify(["/approved/a"]));
  for (const [name, content] of Object.entries(extra)) await writeFile(join(root, scopeKey, "files", name), content);
  await mkdir(join(root, "settings-operation-receipts"), { recursive: true });
  await writeFile(join(root, "settings-operation-receipts", "r1.json"), "{}");
  await writeFile(join(root, scopeKey, "workdirs", "conv", "keep.txt"), "stay");
  return root;
}

const read = async (path: string) => JSON.parse(await readFile(path, "utf8"));

describe("legacy local conversation migration", () => {
  it("copies once per source, keeps the source and leaves working directories in place", async () => {
    const legacy = await legacyDir([{ id: "c1", updatedAt: "2026-01-01", title: "One" }], { "f1.attachment": "bytes" });
    const data = await mkdtemp(join(tmpdir(), "multica-data-")); roots.push(data);
    expect(await migrateLegacyData(legacy, data)).toBe("migrated");
    expect((await read(join(data, scopeKey, "conversations.json"))).sessions.map((s: { id: string }) => s.id)).toEqual(["c1"]);
    expect(await readFile(join(data, scopeKey, "files", "f1.attachment"), "utf8")).toBe("bytes");
    expect(await read(join(data, scopeKey, "preview-roots.json"))).toEqual(["/approved/a"]);
    expect(await readFile(join(data, "settings-operation-receipts", "r1.json"), "utf8")).toBe("{}");
    await expect(readFile(join(data, scopeKey, "workdirs", "conv", "keep.txt"))).rejects.toThrow();
    expect((await readFile(join(legacy, MIGRATED_MARKER), "utf8")).trim()).toBe(data);
    expect(await readFile(join(legacy, scopeKey, "conversations.json"), "utf8")).toContain("c1");

    await writeFile(join(legacy, scopeKey, "conversations.json"), JSON.stringify({ schemaVersion: 1, sessions: [{ id: "late", updatedAt: "2026-02-01" }] }));
    expect(await migrateLegacyData(legacy, data)).toBe("skipped");
    expect((await read(join(data, scopeKey, "conversations.json"))).sessions.map((s: { id: string }) => s.id)).toEqual(["c1"]);
  });

  it("merges a second channel's data by id, keeping the newer conversation and existing files", async () => {
    const stable = await legacyDir([{ id: "shared", updatedAt: "2026-01-01", title: "Stable" }, { id: "only-stable", updatedAt: "2026-01-01", title: "S" }], { "f.attachment": "stable" });
    const canary = await legacyDir([{ id: "shared", updatedAt: "2026-03-01", title: "Canary" }, { id: "only-canary", updatedAt: "2026-01-01", title: "C" }], { "f.attachment": "canary" });
    const data = await mkdtemp(join(tmpdir(), "multica-data-")); roots.push(data);
    await migrateLegacyData(stable, data);
    expect(await migrateLegacyData(canary, data)).toBe("migrated");
    const sessions = (await read(join(data, scopeKey, "conversations.json"))).sessions as { id: string; title: string }[];
    expect(sessions.map((s) => s.id).sort()).toEqual(["only-canary", "only-stable", "shared"]);
    expect(sessions.find((s) => s.id === "shared")?.title).toBe("Canary");
    expect(await readFile(join(data, scopeKey, "files", "f.attachment"), "utf8")).toBe("stable");
  });

  it("does nothing for a missing or identical source", async () => {
    const data = await mkdtemp(join(tmpdir(), "multica-data-")); roots.push(data);
    expect(await migrateLegacyData(join(data, "missing"), data)).toBe("skipped");
    expect(await migrateLegacyData(data, data)).toBe("skipped");
  });
});
