// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalTiming, createLocalPresentationTiming, parseLocalTiming, type LocalTimingRecord } from "./local-timing";

afterEach(() => vi.useRealTimers());
describe("local turn timing", () => {
  it("distinguishes a stalled configuration from a stalled reply and stops heartbeats at termination", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setInterval", "clearInterval"] });
    const records: LocalTimingRecord[] = [];
    const timing = createLocalTiming({ source: "main", conversationId: "conversation", requestId: "request" }, (record) => records.push(record));
    timing.heartbeat(); timing.heartbeat();
    let release!: () => void;
    const waiting = timing.measure("provider.config", () => new Promise<void>((resolve) => { release = resolve; }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(records.at(-1)).toMatchObject({ stage: "provider.config", event: "wait", elapsedMs: 15_000 });
    release(); await waiting;
    timing.mark("provider.input_written");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(records.at(-1)).toMatchObject({ stage: "provider.input_written", event: "wait", idleMs: 15_000 });
    timing.once("provider.first_text"); timing.once("provider.first_text");
    timing.finish("cancelled");
    const count = records.length;
    await vi.advanceTimersByTimeAsync(60_000);
    timing.once("provider.exit");
    expect(records).toHaveLength(count);
    expect(records.filter((record) => record.stage === "provider.first_text")).toHaveLength(1);
    expect(records.at(-1)).toMatchObject({ outcome: "cancelled" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("never logs payloads, credentials or error text, and log failures cannot fail the action", async () => {
    const records: LocalTimingRecord[] = [];
    const timing = createLocalTiming({ source: "main", conversationId: "c" }, (record) => records.push(record));
    await expect(timing.measure("context.credentials", async () => { throw new Error("HTTP 429 secret-token full prompt"); })).rejects.toThrow("HTTP 429");
    expect(records.at(-1)).toMatchObject({ outcome: "failed", failure: "rate_limit" });
    const sanitized = parseLocalTiming({ ...records[0], prompt: "SECRET", env: { TOKEN: "SECRET" } });
    expect(JSON.stringify(sanitized)).not.toContain("SECRET");
    expect(JSON.stringify(records)).not.toMatch(/secret-token|full prompt/);
    expect(parseLocalTiming({ ...records[0], conversationId: "/private/file" })).toBeNull();
    expect(parseLocalTiming({ ...records[0], elapsedMs: Infinity })).toBeNull();
    const broken = createLocalTiming({ source: "main", conversationId: "c" }, () => { throw new Error("disk unavailable"); });
    await expect(broken.measure("turn.persist", async () => "sent")).resolves.toBe("sent");
  });
  it("measures overlapping tools independently without exposing their arguments", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    const records: LocalTimingRecord[] = [];
    const timing = createLocalTiming({ source: "main", conversationId: "c" }, (record) => records.push(record));
    timing.tool("tool_use", "one"); await vi.advanceTimersByTimeAsync(20);
    timing.tool("tool_use", "two"); await vi.advanceTimersByTimeAsync(30);
    timing.tool("tool_result", "two"); timing.tool("tool_result", "one");
    expect(records.filter((record) => record.event === "end").map((record) => record.durationMs)).toEqual([30, 50]);
  });
  it("records one visible output and terminal projection for live turns, ignoring old history", () => {
    const records: LocalTimingRecord[] = [];
    const timing = createLocalPresentationTiming((record) => records.push(record));
    timing.applied("c", "old", true, true);
    timing.applied("c", "live", false, false);
    timing.applied("c", "live", true, false);
    timing.applied("c", "live", true, false);
    timing.applied("c", "live", true, true);
    timing.applied("c", "live", true, true);
    expect(records.map((record) => record.stage)).toEqual(["gui.first_output_applied", "gui.terminal_applied"]);
  });
});
