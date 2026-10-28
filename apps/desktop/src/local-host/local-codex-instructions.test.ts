// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCodexConfiguration } from "./local-codex-instructions";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fake(mode = "normal") {
  const root = await mkdtemp(join(tmpdir(), "multica-codex-config-")); roots.push(root);
  const path = join(root, "fake-codex");
  await writeFile(path, `#!/usr/bin/env node
const fs = require('node:fs');
require('node:readline').createInterface({input: process.stdin}).on('line', (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(join(root, "requests"))}, request.method + '\\n');
  if (!request.id) return;
  if (request.method === 'initialize') return process.stdout.write(JSON.stringify({id: request.id, result: {}}) + '\\n');
  const mode = ${JSON.stringify(mode)};
  const result = mode === 'malformed' ? {config: {developer_instructions: 123}} : mode === 'malformed-mcp' ? {config: {mcp_servers: []}} : {config: {developer_instructions: 'Native developer rules', mcp_servers: {external: {enabled:true}, 'has.dot': {enabled:false}}}};
  process.stdout.write(JSON.stringify(mode === 'unsupported' ? {id: request.id, error: {code: -32601}} : {id: request.id, result}) + '\\n');
});
`, { mode: 0o700 });
  return { root, path };
}

describe.skipIf(process.platform === "win32")("native Codex instruction composition", () => {
  it("reads effective instructions without creating a thread, turn or model request", async () => {
    const { root, path } = await fake();
    expect(await readCodexConfiguration(path, root, process.env, new AbortController().signal)).toEqual({ developerInstructions: "Native developer rules", mcpServerNames: ["external", "has.dot"] });
    expect((await readFile(join(root, "requests"), "utf8")).trim().split("\n")).toEqual(["initialize", "initialized", "config/read"]);
  });
  it.each(["unsupported", "malformed", "malformed-mcp"])("rejects %s config instead of silently discarding user instructions", async (mode) => {
    const { root, path } = await fake(mode);
    await expect(readCodexConfiguration(path, root, process.env, new AbortController().signal)).rejects.toThrow(/instructions safely/);
  });
  it("cancels configuration preparation before any provider execution", async () => {
    const { root, path } = await fake();
    const controller = new AbortController();
    const result = readCodexConfiguration(path, root, process.env, controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow("Execution cancelled");
  });
});
