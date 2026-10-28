import { randomUUID } from "node:crypto";
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { findLocalProvider } from "./local-provider-runner";
import { readClaudePluginSettings } from "./local-provider-extensions";

export interface LocalCompactionInput { provider: "claude" | "codex"; sessionId: string; cwd: string; model?: string | null }
interface Dependencies {
  find(): Promise<string | null>;
  settings: typeof readClaudePluginSettings;
  query(prompt: AsyncIterable<SDKUserMessage>, options: Options): Promise<Query>;
}
const dependencies: Dependencies = {
  find: () => findLocalProvider("claude"),
  settings: readClaudePluginSettings,
  query: async (prompt, options) => (await import("@anthropic-ai/claude-agent-sdk")).query({ prompt, options }),
};

/** Dispatch the built-in command only after discovery; unknown slash commands can become model prompts. */
export async function compactClaudeConversation(input: LocalCompactionInput, signal: AbortSignal, deps = dependencies): Promise<void> {
  signal.throwIfAborted();
  const binary = await deps.find();
  if (!binary) throw new Error("Claude Code is not installed on this computer.");
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let query: Query | undefined;
  let dispatch!: () => void;
  const ready = new Promise<void>((resolve) => { dispatch = resolve; });
  try {
    const settings = await deps.settings(input.cwd, process.env);
    controller.signal.throwIfAborted();
    // Streaming input waits for initialization without submitting any user message.
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      await ready;
      controller.signal.throwIfAborted();
      yield { type: "user", uuid: randomUUID(), session_id: input.sessionId, parent_tool_use_id: null, message: { role: "user", content: "/compact" } };
    }
    query = await deps.query(prompt(), {
      pathToClaudeCodeExecutable: binary, cwd: input.cwd, resume: input.sessionId,
      abortController: controller, settingSources: ["user", "project", "local"],
      settings, plugins: [], strictMcpConfig: true, mcpServers: {},
      ...(input.model ? { model: input.model } : {}),
    });
    const commands = await query.supportedCommands();
    controller.signal.throwIfAborted();
    if (!commands.some((command) => command.name === "compact")) throw new Error("This Claude Code version does not support context compaction. Update Claude Code and retry.");
    dispatch();
    let confirmed = false;
    for await (const message of query) {
      controller.signal.throwIfAborted();
      if (message.type === "system" && message.subtype === "compact_boundary" && message.compact_metadata.trigger === "manual") confirmed = true;
      if (message.type === "result") {
        if (message.subtype !== "success" || message.is_error) throw new Error("Claude Code could not compact this conversation.");
        if (!confirmed) throw new Error("Claude Code did not compact this conversation. There may not be enough messages to summarize.");
        return;
      }
    }
    throw new Error("Claude Code disconnected before confirming compaction.");
  } finally {
    signal.removeEventListener("abort", abort);
    controller.abort(); dispatch();
    query?.close();
  }
}
