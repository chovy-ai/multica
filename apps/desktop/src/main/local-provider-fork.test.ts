// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forkLocalProvider } from "./local-provider-fork";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp() { const root = await mkdtemp(join(tmpdir(), "multica-fork-")); roots.push(root); return root; }

describe("native conversation forks without inference", () => {
  it.skipIf(process.platform === "win32")("forks Codex through the selected native turn and rejects a CLI that copies later turns", async () => {
    const root = await temp(), executable = join(root, "fake-codex"), record = join(root, "requests.json");
    const turns = ["First", "Second", "Future"].map((prompt, index) => ({ id: `native-${index}`, items: [{ type: "userMessage", content: [{ type: "text", text: prompt }] }] }));
    const fixture = (ignoreBoundary: boolean) => `#!/usr/bin/env node
const rl=require('node:readline').createInterface({input:process.stdin});const calls=[];const turns=${JSON.stringify(turns)};
rl.on('line',line=>{const request=JSON.parse(line);calls.push(request);if(!request.id)return;
let result={};if(request.method==='config/read')result={config:{mcp_servers:{external:{enabled:true}}}};if(request.method==='thread/read')result={thread:{id:'source',turns}};
if(request.method==='thread/fork'){require('node:fs').writeFileSync(${JSON.stringify(record)},JSON.stringify(calls));result={thread:{id:'branch',turns:${ignoreBoundary ? 'turns' : 'turns.slice(0,2)'}}};}
console.log(JSON.stringify({id:request.id,result}));});`;
    const input = { provider: "codex" as const, sessionId: "source", cwd: root, title: "Branch", through: { prompts: ["First", "Second", "Future"], index: 1 } };
    await writeFile(executable, fixture(false), { mode: 0o700 });
    expect(await forkLocalProvider(input, new AbortController().signal, executable)).toBe("branch");
    const calls = JSON.parse(await readFile(record, "utf8"));
    expect(calls).toContainEqual(expect.objectContaining({ method: "thread/fork", params: { threadId: "source", lastTurnId: "native-1", excludeTurns: false } }));
    expect(calls.some((call: { method: string }) => call.method === "turn/start")).toBe(false);
    await writeFile(executable, fixture(true), { mode: 0o700 });
    await expect(forkLocalProvider(input, new AbortController().signal, executable)).rejects.toThrow("selected turn");
  });
  it.skipIf(process.platform === "win32")("uses Codex's fork-only command without sending a prompt", async () => {
    const root = await temp(), executable = join(root, "fake-codex"), record = join(root, "request.json");
    await writeFile(executable, `#!/usr/bin/env node
if(process.argv.includes('app-server')){require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);if(request.id)console.log(JSON.stringify({id:request.id,result:request.method==='config/read'?{config:{}}:{}}));});}else{
let input='';process.stdin.on('data',data=>input+=data);process.stdin.on('end',()=>{
require('node:fs').writeFileSync(${JSON.stringify(record)},JSON.stringify({args:process.argv.slice(2),input}));
console.log(JSON.stringify({type:'thread.started',thread_id:'new-thread'}));
});}`, { mode: 0o700 });
    expect(await forkLocalProvider({ provider: "codex", sessionId: "original-thread", cwd: root, title: "Branch" }, new AbortController().signal, executable)).toBe("new-thread");
    expect(JSON.parse(await readFile(record, "utf8"))).toEqual({ args: ["--disable", "plugins", "--disable", "apps", "exec", "fork", "original-thread", "--json", "--skip-git-repo-check"], input: "" });
  });
  it.skipIf(process.platform === "win32")("rejects a failed CLI or a response that reuses the original thread", async () => {
    const root = await temp(), executable = join(root, "fake-codex");
    const input = { provider: "codex" as const, sessionId: "original", cwd: root, title: "Branch" };
    const readConfig = "if(process.argv.includes('app-server')){require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id)console.log(JSON.stringify({id:r.id,result:r.method==='config/read'?{config:{}}:{}}));});}else ";
    await writeFile(executable, `#!/usr/bin/env node\n${readConfig}{console.error('Update Codex');process.exit(1);}`, { mode: 0o700 });
    await expect(forkLocalProvider(input, new AbortController().signal, executable)).rejects.toThrow("Update Codex");
    await writeFile(executable, `#!/usr/bin/env node\n${readConfig}{console.log(JSON.stringify({type:'thread.started',thread_id:'original'}));}`, { mode: 0o700 });
    await expect(forkLocalProvider(input, new AbortController().signal, executable)).rejects.toThrow("independent");
    const controller = new AbortController(); controller.abort();
    await expect(forkLocalProvider(input, controller.signal, "/test-owned/missing")).rejects.toThrow();
  });
  it("forks an owned Claude transcript with fresh linked message IDs through the official SDK", async () => {
    const root = await temp(), cwd = join(root, "work"), config = join(root, "claude");
    vi.stubEnv("CLAUDE_CONFIG_DIR", config);
    const folder = join(config, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")); await mkdir(folder, { recursive: true });
    const sessionId = randomUUID(), first = randomUUID(), second = randomUUID(), third = randomUUID(), fourth = randomUUID();
    const source = join(folder, `${sessionId}.jsonl`);
    const original = [
      { type: "user", uuid: first, parentUuid: null, sessionId, cwd, isSidechain: false, timestamp: new Date().toISOString(), message: { role: "user", content: "Remember fixture" } },
      { type: "assistant", uuid: second, parentUuid: first, sessionId, cwd, isSidechain: false, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Remembered" }] } },
      { type: "user", uuid: third, parentUuid: second, sessionId, cwd, isSidechain: false, timestamp: new Date().toISOString(), message: { role: "user", content: "Future question" } },
      { type: "assistant", uuid: fourth, parentUuid: third, sessionId, cwd, isSidechain: false, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Future answer" }] } },
    ].map((value) => JSON.stringify(value)).join("\n") + "\n";
    await writeFile(source, original);
    const branch = await forkLocalProvider({ provider: "claude", sessionId, cwd, title: "Branch", through: { prompts: ["Remember fixture", "Future question"], index: 0 } }, new AbortController().signal);
    expect(branch).not.toBe(sessionId);
    const entries = (await readFile(join(folder, `${branch}.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const messages = entries.filter((entry) => entry.type === "user" || entry.type === "assistant");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ parentUuid: null, sessionId: branch, message: { content: "Remember fixture" } });
    expect(messages[1]).toMatchObject({ parentUuid: messages[0].uuid, sessionId: branch });
    expect(messages.every((entry) => entry.uuid !== first && entry.uuid !== second)).toBe(true);
    expect(await readFile(source, "utf8")).toBe(original);
  });
});
