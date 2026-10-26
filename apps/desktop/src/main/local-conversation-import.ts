import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { LocalConversation, LocalConversationScope, LocalImportPage, LocalImportResult, LocalProviderId } from "@multica/tutti-agent-gui-host/local-protocol";
import { LocalNativeHistory, type NativeHistoryReader } from "./local-native-history";
import { forkLocalProvider } from "./local-provider-fork";

interface Options {
  rows(scope: LocalConversationScope): Promise<Map<string, LocalConversation>>;
  assertCurrent(scope: LocalConversationScope): void;
  save(scope: LocalConversationScope): Promise<void>;
  notify(scope: LocalConversationScope, id: string): void;
  history?: NativeHistoryReader;
  fork?: typeof forkLocalProvider;
}
/** Native sources are copied, never resumed or edited by an import. */
export class LocalConversationImport {
  private history: NativeHistoryReader;
  private controllers = new Map<AbortController, string>();
  private operations = new Set<Promise<unknown>>();
  private busy = new Set<string>();
  constructor(private options: Options) { this.history = options.history ?? new LocalNativeHistory(); }
  cancel(scope?: LocalConversationScope) { for (const [controller, key] of this.controllers) if (!scope || key === JSON.stringify(scope)) controller.abort(); }
  async stop() { this.cancel(); await Promise.allSettled([...this.operations]); }
  private async run<T>(scope: LocalConversationScope, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.options.assertCurrent(scope);
    const controller = new AbortController(); this.controllers.set(controller, JSON.stringify(scope));
    const operation = action(controller.signal).finally(() => { this.controllers.delete(controller); this.operations.delete(operation); });
    this.operations.add(operation); return operation;
  }
  private check(scope: LocalConversationScope, signal: AbortSignal) { signal.throwIfAborted(); this.options.assertCurrent(scope); }
  private existing(rows: Map<string, LocalConversation>, provider: LocalProviderId, id: string) {
    return [...rows.values()].find((entry) => entry.provider === provider && (entry.providerSessionId === id || entry.importedFrom?.sessionId === id));
  }
  list(scope: LocalConversationScope, provider: LocalProviderId, cursor?: string): Promise<LocalImportPage> {
    return this.run(scope, async (signal) => {
      const page = await this.history.list(provider, cursor, signal); this.check(scope, signal);
      const rows = await this.options.rows(scope); this.check(scope, signal);
      return { ...page, sessions: page.sessions.map((entry) => ({ ...entry, importedId: this.existing(rows, provider, entry.id)?.id })) };
    });
  }
  import(scope: LocalConversationScope, provider: LocalProviderId, ids: string[], projectId: string | null): Promise<LocalImportResult> {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id))) return Promise.reject(new Error("Select between 1 and 100 valid native sessions"));
    const key = JSON.stringify(scope);
    if (this.busy.has(key)) return Promise.reject(new Error("A conversation import is already running in this workspace"));
    this.busy.add(key);
    return this.run(scope, async (signal) => {
      const result: LocalImportResult = { imported: [], skipped: [], failed: [] };
      const rows = await this.options.rows(scope);
      for (const sourceId of new Set(ids)) {
        this.check(scope, signal);
        const previous = this.existing(rows, provider, sourceId);
        if (previous) { result.skipped.push({ sourceId, conversationId: previous.id }); continue; }
        try {
          const source = await this.history.read(provider, sourceId, signal); this.check(scope, signal);
          if (source.id !== sourceId || source.provider !== provider || !source.messages.length) throw new Error("Native conversation has no readable messages");
          if (!isAbsolute(source.cwd) || !(await stat(source.cwd)).isDirectory()) throw new Error("The original working directory is unavailable");
          this.check(scope, signal);
          let branchId: string;
          if (!this.options.fork && provider === "claude") {
            // Keep UUID resolution consistent with discovery, including symlinked project directories.
            const { forkSession } = await import("@anthropic-ai/claude-agent-sdk"); this.check(scope, signal);
            branchId = (await forkSession(sourceId, { title: source.title })).sessionId;
          } else branchId = await (this.options.fork ?? forkLocalProvider)({ provider, sessionId: sourceId, cwd: source.cwd, title: source.title }, signal);
          this.check(scope, signal);
          if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(branchId) || branchId === sourceId) throw new Error("The provider did not create an independent history branch");
          // Read the copied branch so concurrent native CLI activity cannot mismatch the imported snapshot.
          const branch = await this.history.read(provider, branchId, signal); this.check(scope, signal);
          if (!branch.messages.length || branch.id !== branchId || branch.provider !== provider) throw new Error("Could not read the independent history branch");
          const entry: LocalConversation = { id: randomUUID(), title: source.title, provider, cwd: source.cwd, providerSessionId: branchId,
            importedFrom: { provider, sessionId: sourceId }, projectId, pinned: false, archived: false, model: null,
            createdAt: source.createdAt, updatedAt: source.updatedAt, messages: branch.messages, turns: branch.turns };
          rows.set(entry.id, entry);
          try { await this.options.save(scope); } catch (error) { rows.delete(entry.id); throw error; }
          this.check(scope, signal); this.options.notify(scope, entry.id);
          result.imported.push({ sourceId, conversationId: entry.id });
        } catch (error) {
          this.check(scope, signal);
          result.failed.push({ sourceId, error: error instanceof Error ? error.message : "Could not import this conversation" });
        }
      }
      return result;
    }).finally(() => this.busy.delete(key));
  }
}
