// @vitest-environment node
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalProviderUsageReader, parseAccountUsage, parseContextUsage, probeProviderUsage } from "./local-provider-usage";
import type { LocalConversation } from "@multica/tutti-agent-gui-host/local-protocol";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function temp() {
  const root = await mkdtemp(join(tmpdir(), "multica-usage-"));
  cleanups.push(() => rm(root, { recursive: true, force: true })); return root;
}
const account = { subscription_type: "max", rate_limits_available: true, rate_limits: {
  five_hour: { utilization: 22, resets_at: "2099-01-01T12:00:00Z" }, seven_day: { utilization: 5, resets_at: "2099-01-05T12:00:00Z" },
} };
describe("local provider usage", () => {
  it("uses the Claude compaction boundary count and clears old usage when no post-compaction count is reported", () => {
    const before = { type: "assistant", message: { model: "test-model", usage: { input_tokens: 900 } } };
    const boundary = { type: "system", subtype: "compact_boundary", timestamp: "2026-10-27T18:00:00Z", compactMetadata: { trigger: "manual", preTokens: 900 } };
    expect(parseContextUsage("claude", [before, boundary], 1000)).toMatchObject({ usedTokens: null, limitTokens: 1000, model: "test-model" });
    expect(parseContextUsage("claude", [before, { ...boundary, compactMetadata: { ...boundary.compactMetadata, postTokens: 150 } }])).toMatchObject({ usedTokens: 150 });
    expect(parseContextUsage("claude", [before, boundary, { ...before, message: { model: "test-model", usage: { input_tokens: 180 } } }])).toMatchObject({ usedTokens: 180 });
    expect(parseContextUsage("claude", [before, { ...boundary, isSidechain: true }])).toMatchObject({ usedTokens: 900 });
  });
  it("reads only structured quota fields and does not invent absent limits or expose credentials", () => {
    const parsed = parseAccountUsage("claude", { ...account, token: "must-not-leak", rate_limits: { ...account.rate_limits, model_scoped: [{ display_name: "Fable", utilization: 0, resets_at: null }] } });
    expect(parsed).toMatchObject({ status: "available", plan: "max", windows: [{ id: "five_hour", usedPercent: 22 }, { id: "seven_day", usedPercent: 5 }, { label: "Fable", usedPercent: 0 }] });
    expect(JSON.stringify(parsed)).not.toContain("must-not-leak");
    expect(parseAccountUsage("claude", {})).toMatchObject({ status: "unavailable", windows: [] });
    expect(parseAccountUsage("claude", { rate_limits: { five_hour: { utilization: "22" }, seven_day: { utilization: NaN } } }).windows).toEqual([]);
  });
  it("keeps Codex's actual quota window duration instead of assuming its primary bucket is five hours", () => {
    expect(parseAccountUsage("codex", { rateLimitsByLimitId: { codex: { planType: "pro", primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 2000000000 } } } })).toMatchObject({ plan: "pro", windows: [{ id: "codex:primary", label: "7d", usedPercent: 10, resetsAt: "2033-05-18T03:33:20.000Z" }] });
  });
  it("uses the latest Claude input plus cache tokens, excluding output and subagent usage", () => {
    const first = { type: "assistant", timestamp: "2026-01-01T00:00:00Z", message: { model: "test-model", usage: { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 50 } } };
    const last = { ...first, message: { ...first.message, usage: { input_tokens: 3, cache_read_input_tokens: 150, cache_creation_input_tokens: 20, output_tokens: 500 } } };
    expect(parseContextUsage("claude", [first, first, last, { ...first, isSidechain: true }], 1000)).toMatchObject({ usedTokens: 173, limitTokens: 1000, model: "test-model" });
    expect(parseContextUsage("claude", [])).toMatchObject({ usedTokens: null, limitTokens: null });
  });
  it("uses Codex's latest context count rather than lifetime billed tokens and does not double-count cached input", () => {
    const row = { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 100000 }, last_token_usage: { total_tokens: 250, cached_input_tokens: 100 }, model_context_window: 1000 } } };
    expect(parseContextUsage("codex", [row])).toMatchObject({ usedTokens: 250, limitTokens: 1000 });
  });
  it("probes Claude with control messages only, without sending a model prompt or changing native history", async () => {
    const root = await temp(), executable = join(root, "fake-provider");
    await writeFile(executable, `#!/usr/bin/env node
const fs=require('node:fs');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const input=JSON.parse(line);fs.appendFileSync(${JSON.stringify(join(root, "requests.jsonl"))},line+'\\n');
 const result=input.request.subtype==='initialize'?{}:${JSON.stringify(account)};
 console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:input.request_id,response:result}}));
});`, { mode: 0o700 });
    const result = await probeProviderUsage("claude", executable);
    expect(parseAccountUsage("claude", result).plan).toBe("max");
    const sent = (await readFile(join(root, "requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(sent.map((item) => item.request.subtype)).toEqual(["initialize", "get_usage"]);
    expect(sent.every((item) => item.type === "control_request")).toBe(true);
  });
  it("restores context from the owned transcript, merges CLI window size, and deduplicates quota reads", async () => {
    const root = await temp(); await mkdir(join(root, "projects", "project"), { recursive: true });
    await writeFile(join(root, "projects", "project", "native-session.jsonl"), JSON.stringify({ type: "assistant", message: { model: "test-model", usage: { input_tokens: 2, cache_creation_input_tokens: 14886, cache_read_input_tokens: 11334 } } }) + "\n");
    const probe = vi.fn(async () => ({ ...account, session: { model_usage: { "test-model": { contextWindow: 1000000 } } } }));
    const reader = new LocalProviderUsageReader({ claudeHome: root, find: async () => "/test-owned/unused", probe });
    const entry = { provider: "claude", providerSessionId: "native-session" } as LocalConversation;
    const [a, b] = await Promise.all([reader.read("claude", entry), reader.read("claude", entry)]);
    expect(probe).toHaveBeenCalledOnce(); expect(b).toEqual(a);
    expect(a.context).toMatchObject({ usedTokens: 26222, limitTokens: 1000000 });
    await reader.read("claude", entry, true); expect(probe).toHaveBeenCalledOnce();
    reader.reset(); await reader.read("claude", entry); expect(probe).toHaveBeenCalledTimes(2);
    reader.reset();
  });
  it("uses the Codex account RPC without starting a thread or turn", async () => {
    const root = await temp(), executable = join(root, "fake-codex");
    await writeFile(executable, `#!/usr/bin/env node
const fs=require('node:fs');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const input=JSON.parse(line);fs.appendFileSync(${JSON.stringify(join(root, "requests.jsonl"))},line+'\\n');
 if(input.id!==undefined)console.log(JSON.stringify({id:input.id,result:input.id===1?{}:{rateLimits:{primary:{usedPercent:10,windowDurationMins:10080}}}}));
});`, { mode: 0o700 });
    const result = await probeProviderUsage("codex", executable);
    expect(parseAccountUsage("codex", result).windows).toMatchObject([{ usedPercent: 10 }]);
    const sent = (await readFile(join(root, "requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(sent.map((item) => item.method)).toEqual(["initialize", "initialized", "account/rateLimits/read"]);
  });
  it("marks retained quotas stale when refresh fails and keeps context independent from that failure", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const probe = vi.fn().mockResolvedValueOnce(account).mockRejectedValueOnce(new Error("private provider detail"));
    const reader = new LocalProviderUsageReader({ find: async () => "/test-owned/unused", probe });
    await reader.read("claude"); vi.setSystemTime(Date.now() + 61000);
    const result = await reader.read("claude", undefined, true);
    expect(result.account).toMatchObject({ status: "error", stale: true, windows: [{ usedPercent: 22 }, { usedPercent: 5 }] });
    expect(JSON.stringify(result)).not.toContain("private provider detail"); reader.reset();
  });
});
