// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compactClaudeConversation } from "./local-claude-compaction";
import type { Query, Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(mode: "success" | "unsupported" | "no-boundary" | "failed" | "hold" | "disconnect") {
  const root = await mkdtemp(join(tmpdir(), "multica-compact-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "fake-claude"), log = join(root, "inputs.jsonl");
  await writeFile(log, "");
  await writeFile(binary, `#!${process.execPath}
const {randomUUID}=require('node:crypto'),fs=require('node:fs');
const mode=${JSON.stringify(mode)},log=${JSON.stringify(log)};
const emit=value=>process.stdout.write(JSON.stringify({uuid:randomUUID(),session_id:'native-session',...value})+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const input=JSON.parse(line);fs.appendFileSync(log,line+'\\n');
 if(input.type==='control_request') emit({type:'control_response',response:{subtype:'success',request_id:input.request_id,response:{commands:mode==='unsupported'?[]:[{name:'compact',description:'Compact context',argumentHint:''}],models:[],output_style:'default',available_output_styles:[]}}});
 if(input.type==='user'){
   if(mode==='hold')return;
   if(mode==='disconnect')return process.exit(1);
   if(mode==='success')emit({type:'system',subtype:'compact_boundary',compact_metadata:{trigger:'manual',pre_tokens:900}});
   emit({type:'result',subtype:'success',is_error:mode==='failed',result:'Fixture result'});
 }
});
`, { mode: 0o700 });
  let query: Query | undefined;
  const deps = {
    find: async () => binary,
    settings: async () => ({ enabledPlugins: {}, syncClaudeAiPlugins: false as const }),
    query: async (prompt: AsyncIterable<SDKUserMessage>, options: Options) => {
      query = (await import("@anthropic-ai/claude-agent-sdk")).query({ prompt, options: { ...options, env: { PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: root } } });
      return query;
    },
  };
  cleanups.push(async () => { query?.close(); });
  const calls = async () => (await readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { deps, calls, input: { provider: "claude" as const, sessionId: "native-session", cwd: root } };
}

describe.skipIf(process.platform === "win32")("Claude compaction through actual SDK and test-owned CLI", { timeout: 15_000 }, () => {
  it("discovers the command and requires a manual boundary before reporting success", async () => {
    const { deps, calls, input } = await setup("success");
    await compactClaudeConversation(input, new AbortController().signal, deps);
    expect((await calls()).filter((row) => row.type === "user").map((row) => row.message.content)).toEqual(["/compact"]);
  });
  it("rejects unsupported commands before sending any prompt", async () => {
    const { deps, calls, input } = await setup("unsupported");
    await expect(compactClaudeConversation(input, new AbortController().signal, deps)).rejects.toThrow(/does not support/);
    expect((await calls()).filter((row) => row.type === "user")).toEqual([]);
  });
  it.each(["no-boundary", "failed", "disconnect"] as const)("reports %s as a failure", async (mode) => {
    const { deps, input } = await setup(mode);
    await expect(compactClaudeConversation(input, new AbortController().signal, deps)).rejects.toThrow();
  });
  it("closes its owned query on cancellation without replaying the command", async () => {
    const { deps, input, calls } = await setup("hold");
    const controller = new AbortController();
    const pending = compactClaudeConversation(input, controller.signal, deps);
    const assertion = expect(pending).rejects.toThrow();
    try { await vi.waitFor(async () => expect((await calls()).some((row) => row.type === "user")).toBe(true), { timeout: 8000 }); }
    finally { controller.abort(); await assertion; }
    expect((await calls()).filter((row) => row.type === "user")).toHaveLength(1);
  });
});
