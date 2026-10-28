import type { LocalTiming } from "@multica/tutti-agent-gui-host/local-timing";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { isLocalReasoningEffort, isLocalPermissionMode, type LocalReasoningEffort, type LocalPermissionMode, type LocalProviderId, type LocalConversationEvent } from "@multica/tutti-agent-gui-host/local-protocol";
import { readCodexConfiguration } from "./local-codex-instructions";
import { CODEX_PLUGIN_ISOLATION_ARGS, codexMcpIsolationArgs, readClaudePluginSettings, type ClaudePluginSettings } from "./local-provider-extensions";
import { CONTEXT_MCP_NAME, CONTEXT_MCP_TOKEN_ENV, CONTEXT_MCP_TOOLS, type ContextMcpRegistration } from "./local-context-mcp";
import { inlineOutputImages } from "./local-output-images";

export function providerArgs(provider: LocalProviderId, model?: string | null, resume?: string, systemPrompt?: string, mcp?: ContextMcpRegistration, titleOnly = false, permissionMode: LocalPermissionMode = "default", extensions: { codexMcpServers?: string[]; claudePlugins?: ClaudePluginSettings } = {}, reasoningEffort?: LocalReasoningEffort | null): string[] {
  if (!isLocalPermissionMode(permissionMode)) throw new Error("Invalid permission mode");
  if (reasoningEffort != null && !isLocalReasoningEffort(reasoningEffort)) throw new Error("Invalid thinking effort");
  const effort = titleOnly || !reasoningEffort ? [] : provider === "codex" ? ["--config", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`] : ["--effort", reasoningEffort];
  const permissions = titleOnly || permissionMode === "default" ? [] : provider === "codex"
    ? [permissionMode === "auto" ? "--approve-for-me" : "--dangerously-bypass-approvals-and-sandbox"]
    : ["--permission-mode", permissionMode === "auto" ? "auto" : "bypassPermissions"];
  if (titleOnly && (resume || mcp)) throw new Error("Title generation must use an independent session");
  if (mcp && extensions.codexMcpServers?.includes(CONTEXT_MCP_NAME)) throw new Error(`Native Codex settings use the reserved Multica MCP name ${CONTEXT_MCP_NAME}. Rename that native entry before using this conversation.`);
  if (provider === "codex") return [...permissions, "exec", ...(resume ? ["resume"] : []), ...effort, "--json", "--skip-git-repo-check", ...(systemPrompt ? ["--config", `developer_instructions=${JSON.stringify(systemPrompt)}`] : []),
    ...CODEX_PLUGIN_ISOLATION_ARGS, ...codexMcpIsolationArgs(extensions.codexMcpServers ?? []),
    ...(titleOnly ? ["--ephemeral", "--sandbox", "read-only", "--disable", "shell_tool", "--disable", "unified_exec"] : []),
    ...(mcp ? ["--config", `mcp_servers.${CONTEXT_MCP_NAME}={url=${JSON.stringify(mcp.url)},bearer_token_env_var=${JSON.stringify(CONTEXT_MCP_TOKEN_ENV)},enabled=true,required=true,default_tools_approval_mode="auto"${mcp.tools?.includes("ask_user_question") ? ",tool_timeout_sec=3600" : ""}}`] : []),
    ...(model ? ["--model", model] : []), ...(resume ? [resume] : []), "-"];
  return ["--print", "--verbose", "--output-format", "stream-json", "--include-partial-messages", ...permissions, ...effort, ...(systemPrompt ? ["--append-system-prompt", systemPrompt] : []),
    "--strict-mcp-config", "--settings", JSON.stringify(extensions.claudePlugins ?? { enabledPlugins: {}, syncClaudeAiPlugins: false }),
    ...(titleOnly ? ["--no-session-persistence", "--tools", "", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands"] : []),
    ...(mcp ? ["--mcp-config", mcp.claudeConfigPath, "--system-prompt-snapshot", "off", "--allowedTools", (mcp.tools ?? CONTEXT_MCP_TOOLS).map((tool) => `mcp__${CONTEXT_MCP_NAME}__${tool}`).join(",")] : []),
    ...(model ? ["--model", model] : []), ...(resume ? ["--resume", resume] : [])];
}

export async function findLocalProvider(provider: LocalProviderId): Promise<string | null> {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const candidates = (process.env.PATH ?? "").split(delimiter).flatMap((folder) => extensions.map((ext) => join(folder, `${provider}${ext.toLowerCase()}`)));
  if (provider === "codex" && process.platform === "darwin") candidates.push(
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  );
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next installed location. */ }
  }
  return null;
}

type Emit = (event: Omit<LocalConversationEvent, "seq" | "created_at">) => void;

export function codexMessageSeparator(previous: string): string {
  if (!previous || previous.endsWith("\n\n")) return "";
  return previous.endsWith("\n") ? "\n" : "\n\n";
}

export class ProviderStream {
  sessionId?: string;
  output = "";
  error?: string;
  private seen = new Set<string>();
  private partialClaude = false;
  private questionCalls = new Set<string>();
  constructor(private provider: LocalProviderId, private emit: Emit) {}
  private images(content: unknown, callId: string): void {
    inlineOutputImages(content).forEach((image, index) => this.emit({ type: "tool_result", tool: "ImageGeneration", call_id: `output-image:${callId}:${index}`, output: JSON.stringify({ type: "image", mimeType: image.mimeType, data: image.data }) }));
  }
  accept(raw: string): void {
    let event: Record<string, any>; // Provider envelopes are narrowed by their event tags below.
    try { event = JSON.parse(raw); } catch { return; }
    if (this.provider === "codex") {
      if (event.type === "thread.started" && typeof event.thread_id === "string") this.sessionId = event.thread_id;
      if (event.type === "turn.failed") this.error = event.error?.message || event.message || "Codex execution failed";
      if (event.type === "error") this.emit({ type: "status", content: event.message || "Provider connection interrupted" });
      const item = event.item;
      if (!item || !String(event.type).startsWith("item.")) return;
      if (item.type === "mcp_tool_call" && item.server === CONTEXT_MCP_NAME && item.tool === "ask_user_question") return;
      if (event.type !== "item.completed") {
        if (event.type === "item.started" && item.type === "command_execution") this.emit({ type: "tool_use", tool: "Bash", input: { command: item.command }, call_id: item.id });
        if (event.type === "item.started" && item.type === "mcp_tool_call") this.emit({ type: "tool_use", tool: `mcp__${item.server}__${item.tool}`, input: item.arguments, call_id: item.id });
        return;
      }
      if (this.seen.has(item.id)) return;
      this.seen.add(item.id);
      if (item.type === "agent_message" && typeof item.text === "string") {
        const content = item.text ? codexMessageSeparator(this.output) + item.text : "";
        this.output += content; this.emit({ type: "text", content });
      }
      else if (item.type === "reasoning" && typeof item.text === "string") this.emit({ type: "thinking", content: item.text });
      else if (item.type === "command_execution") this.emit({ type: "tool_result", tool: "Bash", output: item.aggregated_output ?? "", call_id: item.id });
      else if (item.type === "file_change") this.emit({ type: "tool_result", tool: "Edit", output: JSON.stringify(item.changes ?? []), call_id: item.id });
      else if (item.type === "mcp_tool_call") {
        this.emit({ type: "tool_result", tool: `mcp__${item.server}__${item.tool}`, output: JSON.stringify(item.error ?? (item.result ? { ...item.result, content: imageFreeContent(item.result.content) } : {})), call_id: item.id });
        if (!item.error) this.images(item.result?.content, item.id);
      } else if (item.type === "image_generation" && item.status !== "failed" && typeof item.result === "string") {
        this.images([{ type: "image", mimeType: "image/png", data: item.result }], item.id);
      } else if (item.type === "dynamic_tool_call") this.images(item.content_items ?? item.contentItems, item.id);
      return;
    }
    if (typeof event.session_id === "string") this.sessionId = event.session_id;
    if (event.type === "stream_event") {
      const chunk = event.event;
      if (chunk?.type === "content_block_delta" && chunk.delta?.type === "text_delta") {
        this.partialClaude = true; this.output += chunk.delta.text; this.emit({ type: "text", content: chunk.delta.text });
      } else if (chunk?.delta?.type === "thinking_delta") this.emit({ type: "thinking", content: chunk.delta.thinking });
    }
    if (event.type === "assistant") for (const block of event.message?.content ?? []) {
      if (block.type === "text" && !this.partialClaude) { this.output += block.text; this.emit({ type: "text", content: block.text }); }
      if (block.type === "tool_use") {
        if (block.name === `mcp__${CONTEXT_MCP_NAME}__ask_user_question`) this.questionCalls.add(block.id);
        else this.emit({ type: "tool_use", tool: block.name, input: block.input, call_id: block.id });
      }
    }
    if (event.type === "user") for (const block of event.message?.content ?? []) {
      if (block.type === "tool_result" && !this.questionCalls.has(block.tool_use_id)) {
        this.emit({ type: "tool_result", call_id: block.tool_use_id, output: typeof block.content === "string" ? block.content : JSON.stringify(imageFreeContent(block.content)) });
        if (!block.is_error) this.images(block.content, block.tool_use_id);
      }
    }
    if (event.type === "result") {
      if (event.is_error) this.error = event.result || event.errors?.join("\n") || "Claude Code execution failed";
      else if (typeof event.result === "string") this.output = event.result;
    }
  }
}

function imageFreeContent(content: unknown): unknown {
  return Array.isArray(content) ? content.filter((block) => inlineOutputImages([block]).length === 0) : content;
}

export async function runLocalProvider(input: { timing?: LocalTiming; provider: LocalProviderId; cwd: string; content: string; model?: string | null; reasoningEffort?: LocalReasoningEffort | null; permissionMode?: LocalPermissionMode; resume?: string; systemPrompt?: string; env?: NodeJS.ProcessEnv; mcp?: ContextMcpRegistration; onSessionId?: (id: string) => void; titleOnly?: boolean }, emit: Emit, signal: AbortSignal, executable?: string): Promise<{ output: string; sessionId?: string }> {
  const measure = <T>(stage: Parameters<LocalTiming["measure"]>[0], action: () => Promise<T>) => input.timing ? input.timing.measure(stage, action) : action();
  const binary = await measure("provider.lookup", async () => executable ?? await findLocalProvider(input.provider));
  if (!binary) throw new Error(`${input.provider === "codex" ? "Codex" : "Claude Code"} is not installed on this computer.`);
  if (signal.aborted) throw new Error("Execution cancelled");
  const env = input.env ?? process.env;
  let systemPrompt = input.systemPrompt;
  const native = input.provider === "codex" ? await measure("provider.config", () => readCodexConfiguration(binary, input.cwd, env, signal)) : undefined;
  if (native && systemPrompt) systemPrompt = [native.developerInstructions, systemPrompt].filter(Boolean).join("\n\n");
  const extensions = native ? { codexMcpServers: native.mcpServerNames } : { claudePlugins: await measure("provider.config", () => readClaudePluginSettings(input.cwd, env)) };
  if (signal.aborted) throw new Error("Execution cancelled");
  return new Promise((resolve, reject) => {
    // Only an explicit per-conversation selection overrides native permission settings.
    const child = spawn(binary, providerArgs(input.provider, input.model, input.resume, systemPrompt, input.mcp, input.titleOnly, input.permissionMode, extensions, input.reasoningEffort), { cwd: input.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    child.once("spawn", () => input.timing?.mark("provider.spawn"));
    child.stdout.on("data", () => { input.timing?.activity(); input.timing?.once("provider.first_stdout"); });
    const parser = new ProviderStream(input.provider, emit);
    const lines = createInterface({ input: child.stdout });
    let stderr = "";
    let force: ReturnType<typeof setTimeout> | undefined;
    lines.on("line", (line) => {
      try {
        const event = JSON.parse(line);
        if (typeof event?.type === "string") input.timing?.once("provider.first_event");
        if (event?.type === "turn.completed" || event?.type === "result") input.timing?.mark("provider.result");
      } catch { /* Non-JSON CLI output is not a protocol event. */ }
      const previous = parser.sessionId; parser.accept(line);
      if (parser.sessionId && parser.sessionId !== previous) input.onSessionId?.(parser.sessionId);
    });
    child.stderr.on("data", (data: Buffer) => { input.timing?.activity(); input.timing?.once("provider.first_stderr"); stderr = (stderr + data.toString()).slice(-6000); });
    const stop = () => {
      if (!child.pid || child.exitCode !== null) return;
      if (process.platform === "win32") { child.kill(); return; }
      try { process.kill(-child.pid, "SIGINT"); } catch { return; }
      force = setTimeout(() => { if (child.exitCode === null && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already stopped. */ } } }, 5000);
    };
    signal.addEventListener("abort", stop, { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      input.timing?.mark("provider.exit", { outcome: signal.aborted ? "cancelled" : code !== 0 || parser.error ? "failed" : "completed" });
      signal.removeEventListener("abort", stop); if (force) clearTimeout(force); lines.close();
      if (signal.aborted) reject(new Error("Execution cancelled"));
      else if (code !== 0 || parser.error) reject(new Error(parser.error || stderr.trim() || `Provider exited (${code})`));
      else resolve({ output: parser.output, sessionId: parser.sessionId });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input.content, () => input.timing?.mark("provider.input_written"));
  });
}

export { localProviderModels } from "./local-provider-models";
