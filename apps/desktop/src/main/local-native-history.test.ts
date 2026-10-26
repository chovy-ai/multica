// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalNativeHistory, projectCodexHistory } from "./local-native-history";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(mode = "normal") {
  const root = await mkdtemp(join(tmpdir(), "multica-history-reader-")); roots.push(root);
  const executable = join(root, "fake-codex"), calls = join(root, "calls.jsonl");
  await writeFile(executable, `#!/usr/bin/env node
const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});
const thread={id:'source',cwd:${JSON.stringify(root)},preview:'A chart',createdAt:1700000000,updatedAt:1700000100};
rl.on('line',line=>{const req=JSON.parse(line);fs.appendFileSync(${JSON.stringify(calls)},line+'\\n');if(!req.id)return;
if(${JSON.stringify(mode)}==='hang'&&req.method==='thread/list')return;
let result={}; if(req.method==='thread/list')result={data:[thread],nextCursor:null};
if(req.method==='thread/read')result={thread};
if(req.method==='thread/turns/list')result={data:[{id:req.params.cursor?'t2':'t1',status:'completed',itemsView:'full',items:[{type:req.params.cursor?'agentMessage':'userMessage',text:'<svg/>',content:[{type:'text',text:'Make a diagram'}]}]}],nextCursor:req.params.cursor?null:'older'};
console.log(JSON.stringify({id:req.id,result}));});`, { mode: 0o700 });
  return { root, calls, reader: new LocalNativeHistory(async () => executable) };
}
describe("read-only native history discovery", () => {
  it.skipIf(process.platform === "win32")("lists and reads every Codex page without resuming or starting a turn", async () => {
    const { reader, calls } = await fixture();
    const signal = new AbortController().signal;
    const page = await reader.list("codex", undefined, signal);
    expect(page.sessions[0]).toMatchObject({ id: "source", title: "A chart" });
    expect(page.nextCursor).not.toBeNull();
    expect((await reader.list("codex", page.nextCursor!, signal)).nextCursor).toBeNull();
    const session = await reader.read("codex", "source", signal);
    expect(session.messages.map((message) => message.content)).toEqual(["Make a diagram", "<svg/>"]);
    const requests = (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(requests.filter((request) => request.method === "thread/turns/list")).toHaveLength(2);
    expect(requests.every((request) => ["initialize", "initialized", "thread/list", "thread/read", "thread/turns/list"].includes(request.method))).toBe(true);
    expect(requests.find((request) => request.method === "thread/list").params.useStateDbOnly).toBe(true);
    expect(requests.filter((request) => request.method === "thread/list").map((request) => request.params.archived)).toEqual([false, true]);
  });
  it.skipIf(process.platform === "win32")("cancels an unresponsive native reader without launching a model", async () => {
    const { reader } = await fixture("hang"), controller = new AbortController();
    const operation = reader.list("codex", undefined, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(operation).rejects.toThrow(/cancel/i);
  });
  it("preserves reply markup and observable tools while excluding private reasoning", () => {
    const metadata = { id: "source", provider: "codex" as const, title: "Chart", cwd: "/work", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
    const result = projectCodexHistory(metadata, [{ status: "completed", itemsView: "full", items: [
      { type: "userMessage", content: [{ type: "text", text: "Chart please" }, { type: "localImage", path: "/private/image" }] },
      { type: "reasoning", text: "Private thought" },
      { type: "commandExecution", command: "pwd", aggregatedOutput: "/work", id: "tool" },
      { type: "agentMessage", text: "```html\n<h1>Chart</h1>\n```" },
    ] }]);
    expect(result.messages.at(-1)?.content).toContain("```html");
    expect(result.turns[0]?.events).toContainEqual(expect.objectContaining({ type: "tool_result", output: "/work" }));
    expect(JSON.stringify(result)).not.toContain("Private thought");
    expect(JSON.stringify(result)).not.toContain("/private/image");
    expect(() => projectCodexHistory(metadata, [{ itemsView: "summary", items: [] }])).toThrow(/incomplete/);
  });
});
