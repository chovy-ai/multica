// @vitest-environment node
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalCodexPool } from "./local-codex-pool";
import { CodexContextBridge } from "./local-codex-context-bridge";
import { createServer } from "node:http";
import type { CodexInput } from "./local-codex-worker";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startLocalContextMcp } from "./local-context-mcp";
import { LocalContextData } from "./local-context-data";
import { createLocalTiming, type LocalTimingRecord } from "@multica/tutti-agent-gui-host/local-timing";

const wait = (assertion: () => Promise<unknown>) => vi.waitFor(assertion, { timeout: 5000, interval: 20 });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup(unloadGraceMs?: number) {
  const root = await mkdtemp(join(tmpdir(), "multica-codex-pool-"));
  const binary = join(root, "fake-codex"); const log = join(root, "calls.jsonl"); const config = join(root, "native.json");
  await writeFile(log, "");
  await writeFile(config, JSON.stringify({ model: "fake-model", developer_instructions: "native instructions", mcp_servers: { native: { command: "must-not-run" } } }));
  // This fixture never looks up or invokes an installed provider or a model.
  await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const record = value => fs.appendFileSync(process.env.TEST_LOG, JSON.stringify({pid:process.pid,...value})+'\\n');
record({method:'launch',args:process.argv.slice(2),hasRunPath:Boolean(process.env.MULTICA_TASK_CONFIG_ROOT)});
const loaded = new Map(); const running = new Map(); let next = 0;
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const notify = (method,params) => send({method,params});
const finish = (id,status='completed') => {
  const run = running.get(id); if (!run) return;
  clearInterval(run.timer); running.delete(id);
  if(status==='completed') {
    notify('item/agentMessage/delta',{threadId:id,turnId:run.turn,itemId:run.item,delta:'hello '});
    notify('item/completed',{threadId:id,turnId:run.turn,item:{id:run.item,type:'agentMessage',text:'hello world'}});
  }
  notify('turn/completed',{threadId:id,turn:{id:run.turn,status}});
};
readline.createInterface({input:process.stdin}).on('line', async line => {
  const r=JSON.parse(line); if(!r.method)return;
  record({method:r.method,params:r.params});
  const reply=result=>send({id:r.id,result});
  if(r.method==='initialize') return reply({});
  if(r.method==='initialized') return;
  if(r.method==='config/read') return reply({config:JSON.parse(fs.readFileSync(process.env.TEST_CONFIG,'utf8'))});
  if(r.method==='thread/start'||r.method==='thread/resume') {
    const id=r.params.threadId||'thread-'+process.pid+'-'+(++next);
    if(loaded.has(id)) return send({id:r.id,error:{message:'old MCP thread was not unloaded'}});
    loaded.set(id,r.params); return reply({thread:{id}});
  }
  if(r.method==='turn/start') {
    const id=r.params.threadId; const turn='turn-'+(++next); const content=r.params.input[0].text;
    loaded.get(id).skipClose=content==='noClose';
    if(content==='crash') return process.exit(9);
    const run={turn,item:'item-'+next}; running.set(id,run);
    // Notifications are intentionally emitted before the RPC response.
    notify('turn/started',{threadId:id,turn:{id:turn}}); reply({turn:{id:turn}});
    if(content==='approval') {
      notify('item/commandExecution/requestApproval',{threadId:id,turnId:turn,itemId:run.item});
      send({id:900,method:'item/commandExecution/requestApproval',params:{threadId:id,turnId:turn,itemId:run.item}});
    }
    if(content.startsWith('hold')) run.timer=setInterval(()=>{if(fs.existsSync(path.join(process.env.TEST_ROOT,content+'.release')))finish(id)},10);
    else setImmediate(()=>finish(id));
    return;
  }
  if(r.method==='turn/interrupt') { reply({}); return finish(r.params.threadId,'interrupted'); }
  if(r.method==='thread/unsubscribe') {
    const skip=loaded.get(r.params.threadId)?.skipClose;
    loaded.delete(r.params.threadId); reply({status:'unsubscribed'});
    if(skip)return;
    return notify('thread/closed',{threadId:r.params.threadId});
  }
  reply({});
});
let exiting=false;
const exit=()=>{if(exiting)return;exiting=true;record({method:'exit'});process.exit(0)};
process.on('SIGTERM',exit); process.stdin.on('end',exit);
`);
  await chmod(binary, 0o700);
  const pool = new LocalCodexPool(async () => binary, unloadGraceMs);
  cleanups.push(async () => { await pool.stop(); await rm(root, { recursive: true, force: true }); });
  const input = (content: string, extra: Partial<CodexInput> = {}): CodexInput => ({ provider: "codex", cwd: root, content,
    env: { ...process.env, TEST_ROOT: root, TEST_LOG: log, TEST_CONFIG: config, MULTICA_TASK_CONFIG_ROOT: "private-run-path" }, ...extra });
  const calls = async (): Promise<Record<string, any>[]> => (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const update = (revision: number) => writeFile(config, JSON.stringify({ model: "fake-model", developer_instructions: `native instructions revision ${revision}`, mcp_servers: { native: { command: "must-not-run", revision } } }));
  return { root, pool, input, calls, update };
}

describe("dialogue Codex app-server pool", { timeout: 15_000 }, () => {
  it("records cold startup, reuse, turn acceptance and unload without logging protocol payloads", async () => {
    const { pool, input } = await setup();
    const first: LocalTimingRecord[] = []; const second: LocalTimingRecord[] = [];
    const cold = createLocalTiming({ source: "main", conversationId: "conversation-a", turnId: "turn-a" }, (record) => first.push(record));
    const warm = createLocalTiming({ source: "main", conversationId: "conversation-b", turnId: "turn-b" }, (record) => second.push(record));
    const result = await pool.run("scope", input("PRIVATE_PROMPT", { timing: cold }), vi.fn(), new AbortController().signal);
    await pool.run("scope", input("PRIVATE_PROMPT_2", { timing: warm, resume: result.sessionId }), vi.fn(), new AbortController().signal);
    expect(first.filter((record) => record.stage === "provider.pool_create")).toHaveLength(2);
    expect(second.filter((record) => record.stage === "provider.pool_create")).toHaveLength(0);
    expect(second.filter((record) => record.stage === "provider.pool_reused")).toHaveLength(1);
    for (const records of [first, second]) {
      expect(records).toEqual(expect.arrayContaining(["provider.pool_admission", "provider.lookup", "provider.config", "provider.thread_ready", "provider.turn_start", "provider.thread_unload"].map((stage) => expect.objectContaining({ stage, event: "end", outcome: "completed", durationMs: expect.any(Number) }))));
      expect(records.filter((record) => record.stage === "provider.first_event")).toHaveLength(1);
      expect(records.findIndex((record) => record.stage === "provider.result")).toBeLessThan(records.findIndex((record) => record.stage === "provider.thread_unload"));
    }
    expect(JSON.stringify([first, second])).not.toMatch(/PRIVATE_PROMPT|native instructions|must-not-run|fake-model|private-run-path/);
  });
  it("prewarms exactly two processes and reuses them across turns without replaying transcript deltas", async () => {
    const { pool, input, calls } = await setup(); const emit = vi.fn();
    const result = await pool.run("scope", input("first", { permissionMode: "auto" }), emit, new AbortController().signal);
    expect(result.output).toBe("hello world");
    expect(emit.mock.calls.filter(([event]) => event.type === "text").map(([event]) => event.content).join("")).toBe("hello world");
    await pool.run("scope", input("second", { resume: result.sessionId }), vi.fn(), new AbortController().signal);
    await wait(async () => expect((await calls()).filter((r) => r.method === "initialize")).toHaveLength(2));
    const log = await calls();
    expect(log.filter((r) => r.method === "launch")).toHaveLength(2);
    expect(log.filter((r) => r.method === "initialize")).toHaveLength(2);
    expect(log.filter((r) => r.method === "launch").every((r) => !r.hasRunPath)).toBe(true);
    const first = log.find((r) => r.method === "thread/start")!;
    expect(first.params).toMatchObject({ developerInstructions: "native instructions", approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write" });
    expect(first.params.config.mcp_servers.native).toEqual({ enabled: false });
    expect(log.find((r) => r.method === "thread/resume")?.params).toMatchObject({ threadId: result.sessionId, excludeTurns: true });
  });

  it("multiplexes independent threads and cancels only the requested turn", async () => {
    const { root, pool, input, calls } = await setup();
    const a = new AbortController(); const b = new AbortController(); const ea = vi.fn(); const eb = vi.fn();
    const first = pool.run("scope", input("holdA"), ea, a.signal); void first.catch(() => {});
    const second = pool.run("scope", input("holdB"), eb, b.signal); void second.catch(() => {});
    await wait(async () => expect((await calls()).filter((r) => r.method === "turn/start")).toHaveLength(2));
    a.abort(); await expect(first).rejects.toThrow("cancel");
    const running = (await calls()).filter((r) => r.method === "turn/start");
    expect(running[0]!.pid).toBe(running[1]!.pid);
    expect((await calls()).filter((r) => r.method === "turn/interrupt")).toHaveLength(1);
    expect((await calls()).filter((r) => r.method === "exit")).toHaveLength(0);
    await writeFile(join(root, "holdB.release"), "go"); await expect(second).resolves.toMatchObject({ output: "hello world" });
    expect(ea.mock.calls.filter(([event]) => event.type === "text")).toHaveLength(0);
    expect(eb.mock.calls.filter(([event]) => event.type === "text").map(([event]) => event.content).join("")).toBe("hello world");
  });

  it("refreshes per-turn MCP endpoints and credentials without spawning another pair", async () => {
    const { pool, input, calls } = await setup();
    const firstInput = input("one");
    firstInput.env = { ...firstInput.env, MULTICA_CONTEXT_MCP_TOKEN: "private-first" };
    firstInput.mcp = { url: "http://127.0.0.1:1/first", claudeConfigPath: "unused", tools: ["current_context"] };
    const first = await pool.run("scope", firstInput, vi.fn(), new AbortController().signal);
    const secondInput = input("two", { resume: first.sessionId, systemPrompt: "new turn context" });
    secondInput.env = { ...secondInput.env, MULTICA_CONTEXT_MCP_TOKEN: "private-second" };
    secondInput.mcp = { ...firstInput.mcp, url: "http://127.0.0.1:2/second" };
    await pool.run("scope", secondInput, vi.fn(), new AbortController().signal);
    const log = await calls();
    expect(log.filter((r) => r.method === "launch")).toHaveLength(2);
    const setups = log.filter((r) => r.method === "thread/start" || r.method === "thread/resume");
    const endpoints = setups.map((r) => r.params.config.mcp_servers.multica_desktop_context.url);
    expect(new Set(endpoints).size).toBe(2);
    expect(endpoints.every((url: string) => /^http:\/\/127\.0\.0\.1:\d+\/mcp\//.test(url))).toBe(true);
    expect(setups[1]!.params.developerInstructions).toBe("native instructions\n\nnew turn context");
    expect(JSON.stringify(log)).not.toContain("private-first"); expect(JSON.stringify(log)).not.toContain("private-second");
  });

  it("drains unrelated turns before recycling an instance whose thread closure is delayed", async () => {
    const { root, pool, input, calls } = await setup(100); const signal = new AbortController().signal;
    const sibling = pool.run("scope", input("holdSibling"), vi.fn(), signal); void sibling.catch(() => {});
    await wait(async () => expect((await calls()).filter((r) => r.method === "turn/start")).toHaveLength(1));
    const closing = pool.run("scope", input("noClose"), vi.fn(), signal); void closing.catch(() => {});
    await expect(closing).resolves.toMatchObject({ output: "hello world" });
    expect((await calls()).filter((r) => r.method === "exit")).toHaveLength(0);
    await writeFile(join(root, "holdSibling.release"), "go");
    await expect(sibling).resolves.toMatchObject({ output: "hello world" });
  });

  it("rotates MCP generations without a third live process or interrupting old turns", async () => {
    const { root, pool, input, calls, update } = await setup(); const signal = new AbortController().signal;
    const first = pool.run("scope", input("holdOld"), vi.fn(), signal);
    void first.catch(() => {});
    await wait(async () => expect((await calls()).filter((r) => r.method === "turn/start")).toHaveLength(1));
    await update(2);
    const second = pool.run("scope", input("holdNew"), vi.fn(), signal);
    void second.catch(() => {});
    await wait(async () => expect((await calls()).filter((r) => r.method === "turn/start")).toHaveLength(2));
    const reads = (await calls()).filter((r) => r.method === "config/read").length;
    await update(3);
    const third = pool.run("scope", input("latest"), vi.fn(), signal);
    void third.catch(() => {});
    // A config read proves admission has observed the third revision while both generations are busy.
    await wait(async () => expect((await calls()).filter((r) => r.method === "config/read")).toHaveLength(reads + 1));
    expect((await calls()).filter((r) => r.method === "turn/start")).toHaveLength(2);
    await update(4);
    await writeFile(join(root, "holdOld.release"), "go"); await first;
    await expect(third).resolves.toMatchObject({ output: "hello world" });
    await writeFile(join(root, "holdNew.release"), "go"); await second;
    const log = await calls(); let live = 0; let max = 0;
    for (const r of log) { if (r.method === "launch") live++; if (r.method === "exit") live--; max = Math.max(max, live); }
    expect(max).toBe(2); expect(log.filter((r) => r.method === "turn/interrupt")).toHaveLength(0);
    expect(log.filter((r) => r.method === "thread/start").map((r) => r.pid)).toHaveLength(3);
    expect(log.filter((r) => r.method === "thread/start").at(-1)?.params.developerInstructions).toBe("native instructions revision 4");
  });

  it("does not replay a turn after process failure and can recover on the next explicit send", async () => {
    const { pool, input, calls } = await setup();
    await expect(pool.run("scope", input("crash"), vi.fn(), new AbortController().signal)).rejects.toThrow("disconnected");
    expect((await calls()).filter((r) => r.method === "turn/start")).toHaveLength(1);
    await expect(pool.run("scope", input("next"), vi.fn(), new AbortController().signal)).resolves.toMatchObject({ output: "hello world" });
  });

  it("supports stopping with a pending rotation and never sends that queued prompt", async () => {
    const { pool, input, calls, update } = await setup(); const signal = new AbortController().signal;
    const a = pool.run("scope", input("holdA"), vi.fn(), signal); void a.catch(() => {});
    await wait(async () => expect((await calls()).filter((r) => r.method === "turn/start")).toHaveLength(1));
    await update(2); const b = pool.run("scope", input("holdB"), vi.fn(), signal); void b.catch(() => {});
    await wait(async () => expect((await calls()).filter((r) => r.method === "turn/start")).toHaveLength(2));
    const reads = (await calls()).filter((r) => r.method === "config/read").length;
    await update(3); const c = pool.run("scope", input("must-not-send"), vi.fn(), signal); void c.catch(() => {});
    await wait(async () => expect((await calls()).filter((r) => r.method === "config/read")).toHaveLength(reads + 1));
    await pool.stop();
    await expect(a).rejects.toThrow(); await expect(b).rejects.toThrow(); await expect(c).rejects.toThrow();
    expect((await calls()).filter((r) => r.method === "turn/start")).toHaveLength(2);
  });

  it("rejects non-dialogue jobs before starting processes", async () => {
    const find = vi.fn(); const pool = new LocalCodexPool(find); cleanups.push(() => pool.stop());
    for (const extra of [{ provider: "claude" as const }, { titleOnly: true }]) {
      await expect(pool.run("scope", { provider: "codex", cwd: "/test", content: "title", ...extra }, vi.fn(), new AbortController().signal)).rejects.toThrow("restricted");
    }
    expect(find).not.toHaveBeenCalled();
  });
});

describe("per-turn MCP bridge", () => {
  it("carries a real MCP initialization and tool request to the execution-scoped server", async () => {
    const controller = new AbortController();
    const data = new LocalContextData({ workspaceId: "owned-workspace", local: { list: vi.fn(), read: vi.fn(), file: vi.fn() }, get: vi.fn(), queryCli: vi.fn() });
    const upstream = await startLocalContextMcp(data, { workspace_id: "owned-workspace", conversation_id: "owned-conversation" }, controller.signal);
    const bridge = new CodexContextBridge(); await bridge.start();
    const url = bridge.bind("owned", { url: upstream.url, token: upstream.token, signal: controller.signal });
    const client = new Client({ name: "test-owned-client", version: "1.0.0" });
    cleanups.push(async () => { await client.close(); await bridge.stop(); await upstream.close(); });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } } }));
    const result = await client.callTool({ name: "current_context", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ workspace_id: "owned-workspace", conversation_id: "owned-conversation" }) }]);
  });
  it("keeps credentials and responses separate and revokes finished routes", async () => {
    const received: string[] = [];
    const upstream = createServer((request, response) => { received.push(request.headers.authorization ?? ""); response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ auth: request.headers.authorization })); });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address(); if (!address || typeof address === "string") throw new Error("No test port");
    const bridge = new CodexContextBridge(); await bridge.start();
    cleanups.push(async () => { await bridge.stop(); upstream.closeAllConnections(); await new Promise<void>((resolve) => upstream.close(() => resolve())); });
    const target = `http://127.0.0.1:${address.port}/mcp`; const signal = new AbortController().signal;
    const a = bridge.bind("a", { url: target, token: "private-a", signal }); const b = bridge.bind("b", { url: target, token: "private-b", signal });
    const send = (url: string, token = bridge.token) => fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}" });
    const replies = await Promise.all([send(a), send(b)]);
    expect(await replies[0]!.json()).toEqual({ auth: "Bearer private-a" }); expect(await replies[1]!.json()).toEqual({ auth: "Bearer private-b" });
    bridge.release("a"); expect((await send(a)).status).toBe(403); expect((await send(b, "private-a")).status).toBe(403);
    expect(received.sort()).toEqual(["Bearer private-a", "Bearer private-b"]);
  });
});
