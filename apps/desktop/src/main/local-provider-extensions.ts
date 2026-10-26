import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const CODEX_PLUGIN_ISOLATION_ARGS = ["--disable", "plugins", "--disable", "apps"];

/** Codex merges tables across layers, so an empty mcp_servers table does not clear native servers. */
export function codexMcpIsolationArgs(names: readonly string[]): string[] {
  return names.length ? ["--config", `mcp_servers={${names.map((name) => `${JSON.stringify(name)}={enabled=false}`).join(",")}}`] : [];
}

export type ClaudePluginSettings = {
  enabledPlugins: Record<string, false>;
  syncClaudeAiPlugins: false;
};

async function optionalObject(path: string): Promise<Record<string, unknown>> {
  let source: string;
  try { source = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new Error("Could not read native plugin settings safely"); }
  try {
    const value: unknown = JSON.parse(source);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new Error("Could not read native plugin settings safely: invalid configuration"); }
}

/** Apply flag-tier plugin overrides while keeping auth, model, hooks and skills in their native scopes. */
export async function readClaudePluginSettings(cwd: string, env: NodeJS.ProcessEnv): Promise<ClaudePluginSettings> {
  const home = env.HOME || env.USERPROFILE || homedir();
  const config = resolve(cwd, env.CLAUDE_CONFIG_DIR || join(home, ".claude"));
  const paths = new Set([join(config, "settings.json")]);
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    paths.add(join(directory, ".claude", "settings.json"));
    paths.add(join(directory, ".claude", "settings.local.json"));
    if (dirname(directory) === directory) break;
  }
  const enabledPlugins: Record<string, false> = Object.create(null);
  const add = (value: unknown) => {
    if (value === undefined) return;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Could not read native plugin settings safely: invalid plugin registry");
    for (const name of Object.keys(value)) enabledPlugins[name] = false;
  };
  for (const path of paths) add((await optionalObject(path)).enabledPlugins);
  add((await optionalObject(join(config, "plugins", "installed_plugins.json"))).plugins);
  return { enabledPlugins, syncClaudeAiPlugins: false };
}
