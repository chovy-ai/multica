import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface StdioMcpServer { name: string; command: string; args: string[]; env: Record<string, string> }
export type CodexMcpRegistrationResult = "registered" | "unchanged" | "disabled-by-user" | "codex-missing";
type Exec = (file: string, args: string[]) => Promise<{ stdout: string }>;

const defaultExec: Exec = (file, args) => run(file, args, { timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true });

function sameServer(current: unknown, wanted: StdioMcpServer): boolean {
  if (!current || typeof current !== "object" || !("transport" in current)) return false;
  const transport = current.transport as { type?: unknown; command?: unknown; args?: unknown; env?: unknown };
  return transport.type === "stdio" && transport.command === wanted.command
    && JSON.stringify(transport.args ?? []) === JSON.stringify(wanted.args)
    && JSON.stringify(Object.entries((transport.env ?? {}) as Record<string, string>).sort()) === JSON.stringify(Object.entries(wanted.env).sort());
}

/**
 * Registers a stdio MCP server in the user's Codex config through Codex's own
 * CLI, so the TOML stays Codex-owned. Agents the daemon runs inherit it.
 * A server the user disabled is left alone; an up-to-date one is not rewritten.
 */
export async function registerCodexStdioMcp(codex: string | null, server: StdioMcpServer, exec: Exec = defaultExec): Promise<CodexMcpRegistrationResult> {
  if (!codex) return "codex-missing";
  let current: unknown;
  try { current = JSON.parse((await exec(codex, ["mcp", "get", server.name, "--json"])).stdout); }
  catch { current = undefined; } // Not registered yet (Codex exits non-zero).
  if (current && typeof current === "object" && "enabled" in current && current.enabled === false) return "disabled-by-user";
  if (sameServer(current, server)) return "unchanged";
  await exec(codex, ["mcp", "add", server.name, ...Object.entries(server.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]), "--", server.command, ...server.args]);
  return "registered";
}
