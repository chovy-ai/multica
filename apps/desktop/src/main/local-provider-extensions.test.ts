// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { codexMcpIsolationArgs, readClaudePluginSettings } from "./local-provider-extensions";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp() { const root = await mkdtemp(join(tmpdir(), "multica-extensions-")); roots.push(root); return root; }

it("disables configured and installed Claude plugins per invocation without changing any native settings", async () => {
  const root = await temp(), config = join(root, "custom-config"), project = join(root, "project"), cwd = join(project, "src");
  const files = new Map<string, unknown>([
    [join(config, "settings.json"), { enabledPlugins: { "user@market": true }, model: "keep-model", env: { PROVIDER_SETTING: "keep" }, hooks: { SessionStart: [] } }],
    [join(config, "plugins", "installed_plugins.json"), { version: 2, plugins: { "installed@market": [{ scope: "user" }] } }],
    [join(project, ".claude", "settings.json"), { enabledPlugins: { "project@market": true } }],
    [join(project, ".claude", "settings.local.json"), { enabledPlugins: { "local@market": true, "user@market": false } }],
  ]);
  await mkdir(cwd, { recursive: true });
  for (const [path, value] of files) { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, JSON.stringify(value)); }
  expect(await readClaudePluginSettings(cwd, { HOME: root, CLAUDE_CONFIG_DIR: config })).toEqual({
    enabledPlugins: { "user@market": false, "installed@market": false, "project@market": false, "local@market": false }, syncClaudeAiPlugins: false,
  });
  for (const [path, value] of files) expect(JSON.parse(await readFile(path, "utf8"))).toEqual(value);
});

it("supports an empty native setup and rejects unreadable plugin settings rather than inheriting plugins", async () => {
  const root = await temp();
  expect(await readClaudePluginSettings(root, { HOME: root })).toEqual({ enabledPlugins: {}, syncClaudeAiPlugins: false });
  await mkdir(join(root, ".claude"));
  await writeFile(join(root, ".claude", "settings.json"), "{ broken private config");
  await expect(readClaudePluginSettings(root, { HOME: root })).rejects.toThrow("invalid configuration");
});

it("quotes MCP names as TOML keys instead of treating dots or quotes as config paths", () => {
  expect(codexMcpIsolationArgs(["external", "has.dot", 'quoted"server'])).toEqual(["--config", 'mcp_servers={"external"={enabled=false},"has.dot"={enabled=false},"quoted\\"server"={enabled=false}}']);
  expect(codexMcpIsolationArgs([])).toEqual([]);
});
