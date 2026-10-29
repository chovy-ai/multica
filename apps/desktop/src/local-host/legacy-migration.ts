import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { LocalConversation, LocalFolderProject } from "@multica/core/local-conversation/protocol";
import { LocalConversationStore } from "./local-conversation-store";

const SCOPE_DIR = /^[0-9a-f]{64}$/;
const SHARED_DIRS = ["settings-operation-receipts", "avatar-operation-receipts"];
const RECORD = "migrations.json";
export const MIGRATED_MARKER = "MIGRATED_TO";

interface Document { schemaVersion: 1; sessions: { id: string; updatedAt?: string }[]; folderProjects?: { id: string }[] }

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function writeAtomic(path: string, value: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, path);
}

/** Copies files the target lacks; existing target files always win. */
async function copyMissing(from: string, to: string): Promise<void> {
  let entries;
  try { entries = await readdir(from, { withFileTypes: true }); } catch { return; }
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const target = join(to, entry.name);
    if (!await exists(target)) await copyFile(join(from, entry.name), target);
  }
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[], newer: (a: T, b: T) => boolean): T[] {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) {
    const existing = merged.get(item.id);
    if (!existing || newer(item, existing)) merged.set(item.id, item);
  }
  return [...merged.values()];
}

async function readDocument(path: string): Promise<Document | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value?.schemaVersion === 1 && Array.isArray(value.sessions) ? value : null;
  } catch { return null; }
}

async function migrateScope(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true, mode: 0o700 });
  const legacy = await readDocument(join(from, "conversations.json"));
  if (legacy && await exists(join(to, "index.json"))) {
    const store = new LocalConversationStore(to, () => {});
    await store.open();
    for (const incoming of legacy.sessions) {
      const current = store.rows.get(incoming.id);
      if (!current || (incoming.updatedAt ?? "") > current.updatedAt) store.rows.set(incoming.id, incoming as LocalConversation);
    }
    store.folderProjects = mergeById(store.folderProjects, (legacy.folderProjects ?? []) as LocalFolderProject[], () => false);
    await store.save();
  } else if (legacy) {
    const current = await readDocument(join(to, "conversations.json"));
    const document: Document = current ? {
      schemaVersion: 1,
      sessions: mergeById(current.sessions, legacy.sessions, (a, b) => (a.updatedAt ?? "") > (b.updatedAt ?? "")),
      folderProjects: mergeById(current.folderProjects ?? [], legacy.folderProjects ?? [], () => false),
    } : legacy;
    await writeAtomic(join(to, "conversations.json"), JSON.stringify(document));
  }
  await copyMissing(join(from, "files"), join(to, "files"));
  const roots = async (dir: string): Promise<string[]> => {
    try { const value: unknown = JSON.parse(await readFile(join(dir, "preview-roots.json"), "utf8")); return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
    catch { return []; }
  };
  const previewRoots = [...new Set([...await roots(to), ...await roots(from)])];
  if (previewRoots.length) await writeAtomic(join(to, "preview-roots.json"), JSON.stringify(previewRoots));
}

/**
 * One-way, per-source copy of Desktop's former in-process data. Working
 * directories stay where they are because saved sessions and provider
 * histories reference them by absolute path. The source is kept and marked.
 */
export async function migrateLegacyData(legacyDir: string, dataDir: string): Promise<"migrated" | "skipped"> {
  const source = resolve(legacyDir);
  if (source === resolve(dataDir) || !await exists(source)) return "skipped";
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const recordPath = join(dataDir, RECORD);
  let record: { sources: Record<string, { migratedAt: string }> } = { sources: {} };
  try { record = { sources: {}, ...JSON.parse(await readFile(recordPath, "utf8")) }; } catch { /* First migration. */ }
  if (record.sources[source]) return "skipped";

  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory() && SCOPE_DIR.test(entry.name)) await migrateScope(join(source, entry.name), join(dataDir, entry.name));
  }
  for (const name of SHARED_DIRS) await copyMissing(join(source, name), join(dataDir, name));

  record.sources[source] = { migratedAt: new Date().toISOString() };
  await writeAtomic(recordPath, JSON.stringify(record, null, 2));
  await writeFile(join(source, MIGRATED_MARKER), `${resolve(dataDir)}\n`, { mode: 0o600 });
  return "migrated";
}
