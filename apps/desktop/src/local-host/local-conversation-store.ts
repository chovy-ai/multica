import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { LocalConversation, LocalFolderProject } from "@multica/core/local-conversation/protocol";
import { localMessageDisplayContent } from "@multica/core/local-conversation/protocol";

interface IndexEntry { summary: LocalConversation; file: string; lastTurnStartedAt: string; remoteRunning: boolean; queued: boolean }
interface Index { schemaVersion: 2; sessions: IndexEntry[]; folderProjects: LocalFolderProject[] }
const missing = (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";

/** Index records contain no event history, attachment payloads, or Side context. */
export function conversationSummary(entry: LocalConversation): LocalConversation {
  const { side, promptQueue: _queue, messages, turns, ...metadata } = entry;
  const last = messages.at(-1);
  return { ...metadata,
    ...(side ? { side: { sourceId: side.sourceId, turnId: side.turnId, requestId: side.requestId, context: [] } } : {}),
    messages: last ? [{ id: last.id, role: last.role, content: localMessageDisplayContent(last), turnId: last.turnId, createdAt: last.createdAt }] : [],
    turns: turns.filter((turn) => turn.status === "running" || turn.backgroundTasks?.some((task) => task.status === "running")).map((turn) => ({
      id: turn.id, status: turn.status, createdAt: turn.createdAt, events: [], remote: turn.remote,
      questions: turn.questions?.filter((question) => question.status === "pending"),
      backgroundTasks: turn.backgroundTasks?.filter((task) => task.status === "running").map((task) => ({ id: task.id, description: task.description, status: task.status, ambient: task.ambient })),
    })),
  };
}

/** The index rename commits all changed detail versions together, including queue-to-Side moves. */
export class LocalConversationStore {
  readonly rows = new Map<string, LocalConversation>();
  folderProjects: LocalFolderProject[] = [];
  private index = new Map<string, IndexEntry>();
  private unloaded = new Map<string, LocalConversation>();
  private reads = new Map<string, Promise<LocalConversation>>();
  private writes: Promise<void> = Promise.resolve();
  constructor(private dir: string, private restore: (entry: LocalConversation) => void) {}
  async open(): Promise<void> {
    let data: Index;
    try { data = JSON.parse(await readFile(join(this.dir, "index.json"), "utf8")); }
    catch (error) {
      if (!missing(error)) throw error;
      let legacy;
      try { legacy = JSON.parse(await readFile(join(this.dir, "conversations.json"), "utf8")); }
      catch (error) { if (missing(error)) return; throw error; }
      if (legacy.schemaVersion !== 1 || !Array.isArray(legacy.sessions)) throw new Error("Invalid local conversation file; the original file was preserved.");
      this.folderProjects = this.validateProjects(legacy.folderProjects ?? []);
      for (const entry of legacy.sessions) {
        this.validateSession(entry); this.restore(entry); this.rows.set(entry.id, entry);
      }
      await this.save();
      // Keep the original monolithic file as a recovery copy; subsequent writes use only the new store.
      for (const item of this.index.values()) {
        const summary = structuredClone(item.summary);
        this.rows.set(summary.id, summary); this.unloaded.set(summary.id, summary);
      }
      return;
    }
    if (data.schemaVersion !== 2 || !Array.isArray(data.sessions)) throw new Error("Invalid local conversation index; the original file was preserved.");
    this.folderProjects = this.validateProjects(data.folderProjects);
    for (const item of data.sessions) {
      this.validateSession(item.summary);
      if (!/^[a-f0-9]{64}\.json$/.test(item.file) || typeof item.lastTurnStartedAt !== "string" || typeof item.remoteRunning !== "boolean" || this.rows.has(item.summary.id)) throw new Error("Invalid local conversation index entry");
      this.index.set(item.summary.id, item);
      const summary = structuredClone(item.summary); this.restore(summary);
      this.rows.set(summary.id, summary); this.unloaded.set(summary.id, summary);
    }
  }
  private validateSession(entry: LocalConversation): void {
    if (!entry || typeof entry.id !== "string" || !["codex", "claude"].includes(entry.provider) || !Array.isArray(entry.messages) || !Array.isArray(entry.turns)) throw new Error("Invalid local conversation file; the original file was preserved.");
  }
  private validateProjects(projects: LocalFolderProject[]): LocalFolderProject[] {
    if (!Array.isArray(projects) || projects.some((project) => !project || typeof project.id !== "string" || !project.id || typeof project.title !== "string" || typeof project.path !== "string" || !isAbsolute(project.path) || typeof project.createdAt !== "string")) throw new Error("Invalid local folder projects; the original file was preserved.");
    return projects;
  }
  isLoaded(entry: LocalConversation): boolean { return this.unloaded.get(entry.id) !== entry; }
  recency(entry: LocalConversation): string { return this.isLoaded(entry) ? entry.turns.at(-1)?.createdAt ?? entry.createdAt : this.index.get(entry.id)!.lastTurnStartedAt; }
  hasQueuedPrompts(entry: LocalConversation): boolean { return this.isLoaded(entry) ? !!entry.promptQueue?.items.length : this.index.get(entry.id)?.queued === true; }
  remoteIds(): string[] { return [...this.index.values()].filter((item) => item.remoteRunning).map((item) => item.summary.id); }
  async read(id: string): Promise<LocalConversation> {
    const current = this.rows.get(id);
    if (!current) throw new Error("Local conversation not found");
    if (this.isLoaded(current)) return current;
    const pending = this.reads.get(id); if (pending) return pending;
    const operation = (async () => {
      const entry = JSON.parse(await readFile(join(this.dir, "details", this.index.get(id)!.file), "utf8"));
      this.validateSession(entry);
      if (entry.id !== id) throw new Error("Local conversation detail does not match index");
      this.restore(entry); this.rows.set(id, entry); this.unloaded.delete(id); return entry;
    })().finally(() => this.reads.delete(id));
    this.reads.set(id, operation); return operation;
  }
  save(): Promise<void> {
    this.validateProjects(this.folderProjects);
    const updates = [...this.rows.values()].filter((entry) => this.isLoaded(entry)).map((entry) => {
      this.validateSession(entry);
      const content = JSON.stringify(entry);
      const file = `${createHash("sha256").update(content).digest("hex")}.json`;
      const item: IndexEntry = { summary: conversationSummary(entry), file, lastTurnStartedAt: this.recency(entry), remoteRunning: entry.turns.some((turn) => turn.status === "running" && !!turn.remote), queued: !!entry.promptQueue?.items.length };
      return { item, content };
    });
    const folders = structuredClone(this.folderProjects);
    const ids = new Set(this.rows.keys());
    const next = this.writes.catch(() => {}).then(async () => {
      const index = new Map([...this.index].filter(([id]) => ids.has(id)));
      const obsolete = new Set<string>();
      await mkdir(join(this.dir, "details"), { recursive: true, mode: 0o700 });
      for (const { item, content } of updates) {
        const previous = index.get(item.summary.id);
        if (previous?.file !== item.file) {
          const temp = join(this.dir, "details", `${randomUUID()}.tmp`);
          await writeFile(temp, content, { mode: 0o600 }); await rename(temp, join(this.dir, "details", item.file));
          if (previous) obsolete.add(previous.file);
        }
        index.set(item.summary.id, item);
      }
      const data: Index = { schemaVersion: 2, sessions: [...index.values()], folderProjects: folders };
      const temp = join(this.dir, `${randomUUID()}.tmp`);
      await writeFile(temp, JSON.stringify(data), { mode: 0o600 }); await rename(temp, join(this.dir, "index.json"));
      this.index = index;
      await Promise.all([...obsolete].filter((file) => !data.sessions.some((item) => item.file === file)).map((file) => unlink(join(this.dir, "details", file)).catch(() => {})));
    });
    this.writes = next; return next;
  }
}
