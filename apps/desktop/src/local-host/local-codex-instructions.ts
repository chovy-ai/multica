import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { CODEX_PLUGIN_ISOLATION_ARGS } from "./local-provider-extensions";

export interface CodexNativeConfiguration { developerInstructions: string; mcpServerNames: string[] }

/** Resolve native config without creating a thread, sending a turn, or calling a model. */
export function readCodexConfiguration(executable: string, cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<CodexNativeConfiguration> {
  if (signal.aborted) return Promise.reject(new Error("Execution cancelled"));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...CODEX_PLUGIN_ISOLATION_ARGS, "app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const kill = (force = false) => {
      if (!child.pid || child.exitCode !== null) return;
      try {
        if (process.platform === "win32") child.kill();
        else process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
      } catch { /* The owned config reader already exited. */ }
    };
    const finish = (error?: Error, value?: CodexNativeConfiguration) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); signal.removeEventListener("abort", cancel); lines.close();
      kill(); const escalation = setTimeout(() => kill(true), 2000); escalation.unref();
      if (error) reject(error); else resolve(value!);
    };
    const cancel = () => finish(new Error("Execution cancelled"));
    const timeout = setTimeout(() => finish(new Error("Could not read Codex instructions safely: configuration request timed out")), 10_000);
    signal.addEventListener("abort", cancel, { once: true });
    child.stderr.resume();
    child.on("error", () => finish(new Error("Could not read Codex instructions safely: configuration reader unavailable")));
    child.on("close", () => finish(new Error("Could not read Codex instructions safely: configuration reader disconnected")));
    child.stdin.on("error", () => finish(new Error("Could not read Codex instructions safely: configuration reader disconnected")));
    const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
    lines.on("line", (line) => {
      let reply: { id?: number; error?: unknown; result?: { config?: { developer_instructions?: unknown; mcp_servers?: unknown } } };
      try { reply = JSON.parse(line); } catch { return; }
      if (!reply || (reply.id !== 1 && reply.id !== 2)) return;
      if (reply.error) { finish(new Error("This Codex version cannot read native instructions safely; update Codex and retry.")); return; }
      if (reply.id === 1) {
        send({ method: "initialized" });
        send({ id: 2, method: "config/read", params: { cwd, includeLayers: false } });
      } else {
        const config = reply.result?.config;
        if (!config || typeof config !== "object" || Array.isArray(config) || (config.developer_instructions != null && typeof config.developer_instructions !== "string")) {
          finish(new Error("Could not read Codex instructions safely: invalid configuration response")); return;
        }
        if (config.mcp_servers != null && (typeof config.mcp_servers !== "object" || Array.isArray(config.mcp_servers))) {
          finish(new Error("Could not read Codex instructions safely: invalid MCP configuration")); return;
        }
        finish(undefined, { developerInstructions: typeof config.developer_instructions === "string" ? config.developer_instructions : "", mcpServerNames: Object.keys(config.mcp_servers ?? {}) });
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "multica_context", version: "0.1.0" } } });
  });
}
