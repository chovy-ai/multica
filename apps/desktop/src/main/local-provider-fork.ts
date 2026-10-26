import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { LocalProviderId } from "@multica/tutti-agent-gui-host/local-protocol";
import { findLocalProvider } from "./local-provider-runner";
import { readCodexConfiguration } from "./local-codex-instructions";
import { CODEX_PLUGIN_ISOLATION_ARGS, codexMcpIsolationArgs } from "./local-provider-extensions";

export interface LocalProviderForkInput {
  provider: LocalProviderId; sessionId: string; cwd: string; title: string;
  through?: { prompts: string[]; index: number };
}

export class ForkBoundaryUnavailable extends Error {}

function promptMatches(actual: string, expected: string) {
  return actual === expected || actual.startsWith(`${expected}\n\n`);
}
function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
}

async function forkCodexThrough(input: LocalProviderForkInput, signal: AbortSignal, binary: string, isolation: string[]): Promise<string> {
  const through = input.through!;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...isolation, "app-server"], { cwd: input.cwd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const kill = (force = false) => {
      if (!child.pid || child.exitCode !== null) return;
      try { if (process.platform === "win32") child.kill(); else process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); } catch { /* Already stopped. */ }
    };
    const finish = (error?: Error, id?: string) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); lines.close(); kill();
      const escalation = setTimeout(() => kill(true), 2000); escalation.unref();
      if (error) reject(error); else resolve(id!);
    };
    const abort = () => finish(new Error("Conversation fork cancelled"));
    const timer = setTimeout(() => finish(new Error("Codex conversation fork timed out")), 30_000);
    const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
    const turnsMatch = (turns: any[], prompts: string[]) => turns.length === prompts.length && turns.every((turn, index) => {
      if (!turn || typeof turn !== "object" || !Array.isArray(turn.items)) return false;
      const text = turn.items.filter((item: any) => item?.type === "userMessage").map((item: unknown) => messageText(item)).join("\n");
      return typeof turn.id === "string" && promptMatches(text, prompts[index]!);
    });
    lines.on("line", (line) => {
      let reply: any; try { reply = JSON.parse(line); } catch { return; }
      if (![1, 2, 3].includes(reply?.id)) return;
      if (reply.error) { finish(reply.id === 2 ? new ForkBoundaryUnavailable("Native turn history is unavailable") : new Error("Codex could not fork this turn; update Codex and retry")); return; }
      if (reply.id === 1) {
        send({ method: "initialized" }); send({ id: 2, method: "thread/read", params: { threadId: input.sessionId, includeTurns: true } });
      } else if (reply.id === 2) {
        const turns = reply.result?.thread?.turns;
        if (!Array.isArray(turns) || !turnsMatch(turns, through.prompts) || !turns[through.index]) { finish(new ForkBoundaryUnavailable("Saved messages cannot be bound to native turns")); return; }
        send({ id: 3, method: "thread/fork", params: { threadId: input.sessionId, lastTurnId: turns[through.index].id, excludeTurns: false } });
      } else {
        const thread = reply.result?.thread;
        if (!thread || thread.id === input.sessionId || typeof thread.id !== "string" || !Array.isArray(thread.turns) || !turnsMatch(thread.turns, through.prompts.slice(0, through.index + 1))) { finish(new Error("Codex did not confirm a fork ending at the selected turn")); return; }
        finish(undefined, thread.id);
      }
    });
    child.stderr.resume();
    child.on("error", () => finish(new Error("Could not start Codex forking")));
    child.on("close", () => finish(new Error("Codex disconnected before confirming the fork")));
    child.stdin.on("error", () => finish(new Error("Codex fork transport disconnected")));
    signal.addEventListener("abort", abort, { once: true });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "multica_fork", version: "0.1.0" } } });
    if (signal.aborted) abort();
  });
}

/** Fork native history immediately, without submitting a user turn to either model. */
export async function forkLocalProvider(input: LocalProviderForkInput, signal: AbortSignal, executable?: string): Promise<string> {
  signal.throwIfAborted();
  if (input.through && (!Number.isInteger(input.through.index) || input.through.index < 0 || input.through.index >= input.through.prompts.length || input.through.prompts.some((prompt) => typeof prompt !== "string" || !prompt.trim()))) throw new ForkBoundaryUnavailable("Invalid native fork boundary");
  if (input.provider === "claude") {
    const { forkSession, getSessionMessages } = await import("@anthropic-ai/claude-agent-sdk");
    signal.throwIfAborted();
    let upToMessageId: string | undefined;
    if (input.through) {
      const messages = await getSessionMessages(input.sessionId, { dir: input.cwd });
      signal.throwIfAborted();
      const users = messages.map((message, index) => ({ message, index, text: messageText(message.message) })).filter(({ message, text }) => message.type === "user" && text);
      const { prompts, index } = input.through;
      if (users.length !== prompts.length || !users.every((user, offset) => promptMatches(user.text, prompts[offset]!)) || !users[index]) throw new ForkBoundaryUnavailable("Saved messages cannot be bound to native turns");
      upToMessageId = messages[(users[index + 1]?.index ?? messages.length) - 1]!.uuid;
    }
    const result = await forkSession(input.sessionId, { dir: input.cwd, title: input.title, ...(upToMessageId ? { upToMessageId } : {}) });
    signal.throwIfAborted();
    return result.sessionId;
  }
  const binary = executable ?? await findLocalProvider("codex");
  if (!binary) throw new Error("Codex is not installed on this computer.");
  signal.throwIfAborted();
  const config = await readCodexConfiguration(binary, input.cwd, process.env, signal);
  const isolation = [...CODEX_PLUGIN_ISOLATION_ARGS, ...codexMcpIsolationArgs(config.mcpServerNames)];
  signal.throwIfAborted();
  if (input.through) return forkCodexThrough(input, signal, binary, isolation);
  return new Promise((resolve, reject) => {
    // No prompt (including no stdin placeholder): `exec fork` only creates a thread.
    const child = spawn(binary, [...isolation, "exec", "fork", input.sessionId, "--json", "--skip-git-repo-check"], {
      cwd: input.cwd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true,
    });
    const lines = createInterface({ input: child.stdout });
    let id: string | undefined, stderr = "", error: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (force = false) => {
      if (!child.pid || child.exitCode !== null) return;
      try {
        if (process.platform === "win32") child.kill();
        else process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
      } catch { /* The owned fork process has already exited. */ }
    };
    const cancel = (reason: Error) => {
      error ??= reason; kill();
      escalation ??= setTimeout(() => kill(true), 2000); escalation.unref();
    };
    const abort = () => cancel(new Error("Conversation fork cancelled"));
    const timer = setTimeout(() => cancel(new Error("Codex conversation fork timed out")), 30_000);
    signal.addEventListener("abort", abort, { once: true });
    lines.on("line", (line) => {
      try {
        const event = JSON.parse(line);
        if (event?.type === "thread.started" && typeof event.thread_id === "string") id = event.thread_id;
      } catch { /* Ignore CLI diagnostics outside the JSON event stream. */ }
    });
    child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4000); });
    child.on("error", (reason) => { error = reason; });
    child.on("close", (code) => {
      clearTimeout(timer); if (escalation) clearTimeout(escalation);
      signal.removeEventListener("abort", abort); lines.close();
      if (error) reject(error);
      else if (code !== 0) reject(new Error(stderr.trim() || "Codex could not fork this conversation. Update Codex and retry."));
      else if (!id || id === input.sessionId) reject(new Error("Codex did not create an independent conversation."));
      else resolve(id);
    });
    child.stdin.on("error", () => {}); child.stdin.end();
    if (signal.aborted) abort();
  });
}
