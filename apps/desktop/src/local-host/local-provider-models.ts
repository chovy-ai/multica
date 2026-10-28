import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeModel } from "@multica/core/types";
import type { ModelInfo, Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { isLocalReasoningEffort, type LocalConversationModels, type LocalProviderId } from "@multica/core/local-conversation/protocol";
import { findLocalProvider } from "./local-provider-runner";

interface Dependencies {
  codexHome: string;
  findClaude(): Promise<string | null>;
  query(prompt: AsyncIterable<SDKUserMessage>, options: Options): Promise<Pick<Query, "supportedModels" | "close">>;
}
const defaults: Dependencies = {
  codexHome: process.env.CODEX_HOME || join(homedir(), ".codex"),
  findClaude: () => findLocalProvider("claude"),
  query: async (prompt, options) => (await import("@anthropic-ai/claude-agent-sdk")).query({ prompt, options }),
};
const label = (value: string) => value === "xhigh" ? "Extra high" : value[0]!.toUpperCase() + value.slice(1);

/** Ask the installed CLI for capabilities without submitting a user message. */
async function claudeModels(deps: Dependencies): Promise<ModelInfo[]> {
  const binary = await deps.findClaude();
  if (!binary) throw new Error("Claude Code is not installed on this computer.");
  const controller = new AbortController();
  let finish!: () => void;
  const end = new Promise<void>((resolve) => { finish = resolve; });
  const prompt: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({ next: async () => { await end; return { done: true, value: undefined }; } }),
  };
  let query: Pick<Query, "supportedModels" | "close"> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        query = await deps.query(prompt, { pathToClaudeCodeExecutable: binary, abortController: controller,
          settingSources: [], settings: { disableAllHooks: true, enabledPlugins: {}, syncClaudeAiPlugins: false },
          plugins: [], tools: [], strictMcpConfig: true, mcpServers: {}, persistSession: false });
        if (controller.signal.aborted) { query.close(); controller.signal.throwIfAborted(); }
        return query.supportedModels();
      })(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Claude model catalog timed out. Update Claude Code and retry.")), 10_000); }),
    ]);
  } finally {
    clearTimeout(timeout); controller.abort(); finish(); query?.close();
  }
}

let claudeCatalog: { expiresAt: number; result: Promise<LocalConversationModels> } | undefined;
export async function localProviderModels(provider: LocalProviderId, deps: Dependencies = defaults, force = false): Promise<LocalConversationModels> {
  if (provider === "claude") {
    if (deps === defaults && !force && claudeCatalog && claudeCatalog.expiresAt > Date.now()) return claudeCatalog.result;
    const result = claudeModels(deps).then((models): LocalConversationModels => ({ supported: true, models: models.map((model) => ({
      id: model.value, label: model.displayName,
      ...(model.supportsEffort && model.supportedEffortLevels?.length ? { thinking: {
        supported_levels: model.supportedEffortLevels.filter(isLocalReasoningEffort).map((value) => ({ value, label: label(value) })),
      } } : {}),
    })) }));
    if (deps === defaults) {
      const entry = { expiresAt: Date.now() + 60_000, result }; claudeCatalog = entry;
      void result.catch(() => { if (claudeCatalog === entry) claudeCatalog = undefined; });
    }
    return result;
  }
  try {
    const raw: unknown = JSON.parse(await readFile(join(deps.codexHome, "models_cache.json"), "utf8"));
    const rows = record(raw) && Array.isArray(raw.models) ? raw.models : [];
    const models: RuntimeModel[] = [];
    for (const item of rows) {
      if (!record(item) || typeof item.slug !== "string" || item.visibility === "hide") continue;
      const model: RuntimeModel = { id: item.slug, label: typeof item.display_name === "string" ? item.display_name : item.slug };
      if (Array.isArray(item.supported_reasoning_levels)) {
        model.thinking = { supported_levels: item.supported_reasoning_levels.flatMap((level: unknown) =>
          record(level) && isLocalReasoningEffort(level.effort) ? [{ value: level.effort, label: label(level.effort),
            ...(typeof level.description === "string" ? { description: level.description } : {}) }] : []),
          ...(isLocalReasoningEffort(item.default_reasoning_level) ? { default_level: item.default_reasoning_level } : {}),
        };
      }
      models.push(model);
    }
    return { supported: true, models };
  } catch { return { supported: true, models: [] }; }
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
