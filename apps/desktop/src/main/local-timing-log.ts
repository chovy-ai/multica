import { mkdir, appendFile, rename, stat, open } from "node:fs/promises";
import { join } from "node:path";
import { LOCAL_TIMING_PREFIX, parseLocalTiming, type LocalTimingRecord } from "@multica/tutti-agent-gui-host/local-timing";

/** A bounded, best-effort diagnostic log, separate from saved conversation content. */
export class LocalTimingLog {
  private pending = Promise.resolve();
  private queued = 0;
  private size?: number;
  readonly path: string;
  constructor(private directory: string, private maxBytes = 5 * 1024 * 1024) {
    this.path = join(directory, "turn-timing.jsonl");
  }
  write = (value: unknown): void => {
    const record = parseLocalTiming(value);
    if (!record || this.queued >= 1000) return;
    const line = JSON.stringify(record) + "\n";
    this.queued++;
    this.pending = this.pending.then(async () => {
      if (this.size === undefined) {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        this.size = await stat(this.path).then((value) => value.size, () => 0);
      }
      if (this.size > 0 && this.size + Buffer.byteLength(line) > this.maxBytes) {
        await rename(this.path, this.path + ".1");
        this.size = 0;
      }
      await appendFile(this.path, line, { mode: 0o600 });
      this.size += Buffer.byteLength(line);
    }).catch(() => { this.size = undefined; }).finally(() => { this.queued--; });
  };
  console(message: string): void {
    if (!message.startsWith(LOCAL_TIMING_PREFIX) || message.length > 2048) return;
    try {
      const record = parseLocalTiming(JSON.parse(message.slice(LOCAL_TIMING_PREFIX.length)));
      if (record && record.source !== "main") this.write(record);
    } catch { /* Other console output is never persisted here. */ }
  }
  snapshot(conversationIds: ReadonlySet<string>, since: number, until: number): Promise<{ records: LocalTimingRecord[]; incomplete: boolean }> {
    // Join the write queue so rotation cannot split a snapshot across two generations.
    const snapshot = this.pending.then(async () => {
      const records: LocalTimingRecord[] = [];
      let incomplete = false;
      for (const path of [this.path + ".1", this.path]) {
        try {
          const file = await open(path, "r");
          try {
            if ((await file.stat()).size > Math.max(this.maxBytes, 2048)) { incomplete = true; continue; }
            const contents = await file.readFile("utf8");
            for (const line of contents.split("\n")) {
              if (!line.trim()) continue;
              try {
                const record = parseLocalTiming(JSON.parse(line));
                if (!record) { incomplete = true; continue; }
                const at = Date.parse(record.at);
                if (conversationIds.has(record.conversationId) && at >= since && at <= until) records.push(record);
              } catch { incomplete = true; }
            }
          } finally { await file.close(); }
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) incomplete = true;
        }
      }
      records.sort((a, b) => a.at.localeCompare(b.at));
      return { records, incomplete };
    });
    this.pending = snapshot.then(() => undefined, () => undefined);
    return snapshot;
  }
  flush(): Promise<void> { return this.pending; }
}
