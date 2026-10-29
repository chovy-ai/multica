import type { Writable } from "node:stream";

/** The daemon stopped reading adapter output; the adapter must exit rather than buffer without bound. */
export class WriteBacklogError extends Error {}

/**
 * Serializes NDJSON frames onto stdout and honors backpressure: each write
 * waits for `drain` when the stream buffer is full. Queued bytes and the time
 * a single drain may take are both bounded, so a daemon that stops reading
 * surfaces as an error instead of growing memory until `ENOBUFS`.
 */
export class FrameWriter {
  private chain: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private failure?: Error;

  constructor(private output: Writable, private limits: { maxQueuedBytes: number; drainTimeoutMs: number }) {
    output.on("error", (error) => { this.failure ??= error; });
  }

  /** Resolves once the frame is handed to the stream without exceeding its buffer. */
  write(frame: unknown): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    const line = `${JSON.stringify(frame)}\n`;
    const bytes = Buffer.byteLength(line);
    // A single oversized frame is still allowed through when nothing else waits.
    if (this.queuedBytes > 0 && this.queuedBytes + bytes > this.limits.maxQueuedBytes) {
      this.failure = new WriteBacklogError(`adapter output backlog exceeded ${this.limits.maxQueuedBytes} bytes`);
      return Promise.reject(this.failure);
    }
    this.queuedBytes += bytes;
    const written = this.chain.then(() => this.writeLine(line)).finally(() => { this.queuedBytes -= bytes; });
    this.chain = written.catch(() => {});
    return written;
  }

  private writeLine(line: string): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.output.write(line)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (error?: Error) => {
        clearTimeout(timer); this.output.off("drain", onDrain); this.output.off("error", onError);
        if (error) { this.failure ??= error; reject(this.failure); } else resolve();
      };
      const onDrain = () => done();
      const onError = (error: Error) => done(error);
      const timer = setTimeout(() => done(new WriteBacklogError(`daemon did not read adapter output for ${this.limits.drainTimeoutMs} ms`)), this.limits.drainTimeoutMs);
      this.output.once("drain", onDrain);
      this.output.once("error", onError);
    });
  }
}
