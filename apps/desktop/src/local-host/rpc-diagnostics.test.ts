// @vitest-environment node
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { JsonRpcPeer, lineTransport } from "./json-rpc";
import { RpcDiagnostics } from "./rpc-diagnostics";
import { redactDiagnosticText } from "../main/developer-runtime-logs";

describe("local RPC diagnostics", () => {
  it("correlates history response size and latency without persisting payloads or credentials", () => {
    const records: Record<string, any>[] = [];
    let now = 0;
    const diagnostics = new RpcDiagnostics((record) => records.push(record), () => now);
    const id = "11111111-1111-1111-1111-111111111111";
    diagnostics.frame("in", { id: 7, method: "request", params: { method: "read", connectionId: "a".repeat(16), params: { id, content: "private-content", token: "private-token" } } }, 150);
    now = 1200;
    diagnostics.frame("out", { id: 7, result: { messages: [{ content: "private-content" }], turns: [{ events: [{ output: "private-token" }] }] } }, 1234567);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ event: "traffic", in: 1, out: 1, inBytes: 150, outBytes: 1234567, activeRequests: 0,
      methods: { "in:read": 1 }, largestFrame: { rpcId: 7, method: "request", operation: "read", conversationId: id, connectionId: "a".repeat(16), latencyMs: 1200, messageCount: 1, turnCount: 1, eventCount: 1 } });
    expect(JSON.stringify(records)).not.toMatch(/private-content|private-token/);
    expect(JSON.parse(redactDiagnosticText(JSON.stringify(records[0])))).toEqual(JSON.parse(JSON.stringify(records[0])));
  });

  it("captures UTF-8 bytes queued on a stalled output without changing delivery", async () => {
    const records: Record<string, any>[] = [];
    const diagnostics = new RpcDiagnostics((record) => records.push(record));
    let release!: () => void;
    const output = new Writable({ write(_chunk, _encoding, callback) { release = callback; } });
    const input = new PassThrough();
    const transport = lineTransport(input, output, diagnostics);
    const text = "🙂".repeat(2 * 1024 * 1024);
    transport.send(text);
    const expectedBytes = Buffer.byteLength(text) + 1;
    expect(records.find((record) => record.event === "write_pressure")).toMatchObject({ queuedBytes: expectedBytes, queuedFrames: 1, peakQueuedBytes: expectedBytes });
    release();
    await vi.waitFor(() => expect(records.find((record) => record.event === "write_queue_empty")).toMatchObject({ queuedBytes: 0, queuedFrames: 0, failedWrites: 0 }));
    input.end(); output.end();
  });

  it("reports pressure at exponential thresholds rather than adding per-frame log traffic", () => {
    const records: Record<string, any>[] = [];
    const diagnostics = new RpcDiagnostics((record) => records.push(record));
    const mb = 1024 * 1024;
    for (let i = 0; i < 64; i++) diagnostics.queued(mb);
    expect(records.map((record) => record.queuedBytes)).toEqual([8, 16, 32, 64].map((value) => value * mb));
    for (let i = 0; i < 64; i++) diagnostics.written(mb);
    expect(records.at(-1)).toMatchObject({ event: "write_queue_empty", queuedFrames: 0, queuedBytes: 0, peakQueuedFrames: 64 });
  });

  it("keeps the pre-error queue snapshot and distinguishes failed callbacks from successful delivery", () => {
    const records: Record<string, any>[] = [];
    const diagnostics = new RpcDiagnostics((record) => records.push(record));
    diagnostics.queued(8 * 1024 * 1024);
    diagnostics.written(8 * 1024 * 1024, Object.assign(new Error("private-token"), { code: "ENOBUFS" }));
    expect(records.find((record) => record.event === "write_failed")).toMatchObject({ queuedBytes: 8 * 1024 * 1024, queuedFrames: 1, errorCode: "ENOBUFS", failedWrites: 1 });
    expect(records.at(-1)).toMatchObject({ event: "write_queue_empty", queuedBytes: 0, queuedFrames: 0, failedWrites: 1 });
    expect(JSON.stringify(records)).not.toContain("private-token");
  });

  it("observes an unhandled output error without swallowing it or logging its message", () => {
    const records: Record<string, any>[] = [];
    const diagnostics = new RpcDiagnostics((record) => records.push(record));
    const input = new PassThrough(), output = new PassThrough();
    lineTransport(input, output, diagnostics);
    const error = Object.assign(new Error("private-token"), { code: "ENOBUFS" });
    expect(() => output.emit("error", error)).toThrow(error);
    expect(records[0]).toMatchObject({ event: "output_error", errorCode: "ENOBUFS" });
    expect(JSON.stringify(records)).not.toContain("private-token");
    input.end(); output.end();
  });

  it("records session initialization failures immediately with a safe error code", () => {
    const records: Record<string, any>[] = [];
    const diagnostics = new RpcDiagnostics((record) => records.push(record));
    diagnostics.frame("in", { id: 1, method: "request", params: { method: "read", params: {} } }, 100);
    diagnostics.frame("out", { id: 1, error: { code: -32000, data: { code: "session_required", secret: "private-token" } } }, 100);
    expect(records[0]).toMatchObject({ event: "rpc_error", errors: { session_required: 1 }, lastFrame: { operation: "read", errorCode: "session_required" } });
    expect(JSON.stringify(records)).not.toContain("private-token");
  });

  it("preserves RPC delivery when the diagnostic sink fails", async () => {
    const diagnostics = new RpcDiagnostics(() => { throw new Error("sink unavailable"); });
    const input = new PassThrough(), output = new PassThrough();
    const reply = new Promise<string>((resolve) => output.once("data", (data) => resolve(data.toString())));
    new JsonRpcPeer(lineTransport(input, output, diagnostics), () => ({ ok: true }));
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "echo", params: {} }) + "\n");
    diagnostics.record("snapshot");
    expect(JSON.parse(await reply)).toMatchObject({ id: 1, result: { ok: true } });
    input.end(); output.end();
  });

  it("does not retain request metadata after callers cancel or disconnect", async () => {
    const records: Record<string, any>[] = [];
    const diagnostics = new RpcDiagnostics((record) => records.push(record));
    const input = new PassThrough(), output = new PassThrough(); output.resume();
    const peer = new JsonRpcPeer(lineTransport(input, output, diagnostics), () => undefined);
    const signal = new AbortController();
    const aborted = peer.call("host.request", {}, signal.signal);
    signal.abort(new Error("cancelled"));
    await expect(aborted).rejects.toThrow("cancelled");
    diagnostics.record("after_abort");
    expect(records.at(-1)).toMatchObject({ pendingCalls: 0 });
    const disconnected = peer.call("host.request", {});
    input.end();
    await expect(disconnected).rejects.toThrow("connection closed");
    diagnostics.record("after_disconnect");
    expect(records.at(-1)).toMatchObject({ pendingCalls: 0 });
    output.end();
  });
});
