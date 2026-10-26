// @vitest-environment node
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createLocalTiming, LOCAL_TIMING_PREFIX, type LocalTimingRecord } from "@multica/tutti-agent-gui-host/local-timing";
import { LocalTimingLog } from "./local-timing-log";

describe("local timing log", () => {
  it("persists and rotates validated records without copying unrelated console data", async () => {
    const root = await mkdtemp(join(tmpdir(), "multica-timing-"));
    try {
      const log = new LocalTimingLog(root, 700);
      const records: LocalTimingRecord[] = [];
      const timing = createLocalTiming({ source: "renderer", conversationId: "c", requestId: "request" }, (record) => records.push(record));
      timing.mark("gui.submit");
      log.console("unrelated SECRET"); log.console(LOCAL_TIMING_PREFIX + "not-json SECRET");
      for (let i = 0; i < 7; i++) log.console(LOCAL_TIMING_PREFIX + JSON.stringify({ ...records[0], elapsedMs: i, content: "SECRET" }));
      await log.flush();
      const current = await readFile(log.path, "utf8");
      const previous = await readFile(log.path + ".1", "utf8");
      expect(current + previous).not.toContain("SECRET");
      expect(current.trim().split("\n").map((line) => JSON.parse(line)).at(-1).elapsedMs).toBe(6);
      expect(Buffer.byteLength(current)).toBeLessThanOrEqual(700);
      expect(Buffer.byteLength(previous)).toBeLessThanOrEqual(700);
      if (process.platform !== "win32") expect((await stat(log.path)).mode & 0o777).toBe(0o600);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("remains best effort when its destination cannot be written", async () => {
    const root = await mkdtemp(join(tmpdir(), "multica-timing-failure-"));
    try {
      const file = join(root, "file"); await writeFile(file, "occupied");
      const log = new LocalTimingLog(file);
      createLocalTiming({ source: "main", conversationId: "c" }, log.write).mark("turn.execute");
      await expect(log.flush()).resolves.toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("reads both retained files, validates again and reports malformed lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "multica-timing-snapshot-"));
    try {
      const log = new LocalTimingLog(root);
      const row = { version: 1, source: "gui", conversationId: "c", at: new Date().toISOString(), stage: "gui.first_output_applied", event: "mark", elapsedMs: 1 };
      await writeFile(log.path + ".1", JSON.stringify({ ...row, content: "SECRET" }) + "\ninvalid\n");
      log.write({ ...row, source: "main", conversationId: "foreign" });
      log.write({ ...row, source: "main" });
      const snapshot = await log.snapshot(new Set(["c"]), Date.now() - 60000, Date.now() + 1000);
      expect(snapshot.records).toHaveLength(2);
      expect(snapshot.incomplete).toBe(true);
      expect(JSON.stringify(snapshot.records)).not.toMatch(/SECRET|foreign/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
