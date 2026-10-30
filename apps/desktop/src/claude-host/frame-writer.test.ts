// @vitest-environment node
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { FrameWriter, WriteBacklogError } from "./frame-writer";

/** A stream whose consumer only reads when the test says so. */
function slowStream(highWaterMark: number) {
  const chunks: string[] = [];
  const callbacks: (() => void)[] = [];
  const stream = new Writable({
    highWaterMark,
    write(chunk, _encoding, callback) { chunks.push(String(chunk)); callbacks.push(callback); },
  });
  return { stream, chunks, release: () => { while (callbacks.length) callbacks.shift()!(); } };
}

describe("FrameWriter", () => {
  it("writes NDJSON frames in order", async () => {
    const { stream, chunks, release } = slowStream(1 << 20);
    const writer = new FrameWriter(stream, { maxQueuedBytes: 1 << 20, drainTimeoutMs: 1000 });
    const done = Promise.all([writer.write({ n: 1 }), writer.write({ n: 2 })]);
    release(); await done; release();
    expect(chunks).toEqual(['{"n":1}\n', '{"n":2}\n']);
  });

  it("waits for drain instead of buffering past the stream's high-water mark", async () => {
    const { stream, chunks, release } = slowStream(8);
    const writer = new FrameWriter(stream, { maxQueuedBytes: 1 << 20, drainTimeoutMs: 1000 });
    let settled = false;
    const first = writer.write({ payload: "0123456789" }).then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release();
    await first;
    expect(settled).toBe(true);
    expect(chunks).toHaveLength(1);
  });

  it("fails instead of growing when queued frames exceed the backlog limit", async () => {
    const { stream } = slowStream(8);
    const writer = new FrameWriter(stream, { maxQueuedBytes: 64, drainTimeoutMs: 60_000 });
    void writer.write({ payload: "x".repeat(40) }).catch(() => {});
    await expect(writer.write({ payload: "y".repeat(40) })).rejects.toBeInstanceOf(WriteBacklogError);
    // The writer stays failed; the host exits rather than continuing with a gap.
    await expect(writer.write({ n: 1 })).rejects.toBeInstanceOf(WriteBacklogError);
  });

  it("fails when the daemon stops reading for longer than the drain timeout", async () => {
    const { stream } = slowStream(8);
    const writer = new FrameWriter(stream, { maxQueuedBytes: 1 << 20, drainTimeoutMs: 20 });
    await expect(writer.write({ payload: "0123456789" })).rejects.toBeInstanceOf(WriteBacklogError);
  });

  it("reports stream errors to pending and later writes", async () => {
    const stream = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) { callback(new Error("EPIPE")); } });
    const writer = new FrameWriter(stream, { maxQueuedBytes: 1 << 20, drainTimeoutMs: 1000 });
    await expect(writer.write({ n: 1 })).rejects.toThrow("EPIPE");
    await expect(writer.write({ n: 2 })).rejects.toThrow("EPIPE");
  });
});
