// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { modelsSchema } from "./schemas";
import { MobileTimingBuffer, diagnosticsSchema, reportAckSchema } from "./timing";

const scope = { deviceId: "peer-a", workspaceId: "workspace-a" };
const endpoint = { url: "http://127.0.0.1:1", token: "t" };

describe("mobile timing buffer", () => {
  it("is bounded and says how much it lost", () => {
    const buffer = new MobileTimingBuffer(2);
    for (let i = 0; i < 5; i++) buffer.write({ stage: "ws.open", count: i });
    expect(buffer.count).toBe(2);
    const batch = buffer.batch(scope)!;
    expect(batch.records.map((record) => record.count)).toEqual([3, 4, 3]);
    expect(batch.records.at(-1)!.stage).toBe("timing.dropped");
    buffer.acknowledge(batch.batch_id);
    expect(buffer.count).toBe(0);
    expect(buffer.batch(scope)).toBeNull();
  });

  it("keeps a batch and its id until it is acknowledged", () => {
    const buffer = new MobileTimingBuffer();
    buffer.write({ stage: "ws.open" });
    const first = buffer.batch(scope)!;
    buffer.write({ stage: "ws.closed" });
    expect(buffer.batch(scope)!.batch_id).toBe(first.batch_id);
    buffer.acknowledge("another");
    expect(buffer.count).toBe(2);
    buffer.acknowledge(first.batch_id);
    expect(buffer.batch(scope)!.records.map((record) => record.stage)).toEqual(["ws.closed"]);
  });

  it("only reports to an executor what is about it", () => {
    const buffer = new MobileTimingBuffer();
    buffer.write({ stage: "ws.open", peer: "peer-a" });
    buffer.write({ stage: "ws.open", peer: "peer-b" });
    buffer.write({ stage: "network.changed" });
    buffer.write({ stage: "client.send", conversationId: "c", peer: "peer-a" }, "workspace-b");
    expect(buffer.batch(scope)!.records.map((record) => [record.stage, record.peer])).toEqual([["ws.open", "peer-a"], ["network.changed", undefined]]);
  });

  it("drops another account's marks", () => {
    const buffer = new MobileTimingBuffer();
    buffer.forUser("a");
    buffer.write({ stage: "ws.open" });
    buffer.forUser("a");
    expect(buffer.count).toBe(1);
    buffer.forUser("b");
    expect(buffer.count).toBe(0);
  });

  it("keeps no free text and no wrong identity", () => {
    const buffer = new MobileTimingBuffer();
    buffer.write({ stage: "ws.closed", reason: "dial tcp 10.0.0.1 refused" as never, peer: "/ip4/10.0.0.1" });
    buffer.write({ stage: "not.a.mark" as never });
    const [record] = buffer.batch(scope)!.records;
    expect(record).toMatchObject({ stage: "ws.closed", source: "mobile", clientKind: "mobile" });
    expect(record!.reason).toBeUndefined();
    expect(record!.peer).toBeUndefined();
    expect(buffer.count).toBe(1);
  });

  it("drains Go marks from the cursor, counts what Go lost and ignores an older link", async () => {
    const buffer = new MobileTimingBuffer();
    const go = { version: 2, source: "mobile", at: "2026-11-02T10:00:00.000Z", stage: "connection.relayed", event: "mark", elapsedMs: 0, peer: "peer-a", addrType: "relay" };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ records: [go, { stage: "bogus" }], next: 2, dropped: 3 }))
      .mockResolvedValueOnce(Response.json({ records: [], next: 2, dropped: 3 }));
    await buffer.drain(endpoint, fetcher);
    expect(String(fetcher.mock.calls[0]![0])).toBe("http://127.0.0.1:1/diagnostics?after=0");
    expect(String(fetcher.mock.calls[1]![0])).toBe("http://127.0.0.1:1/diagnostics?after=2");
    expect((fetcher.mock.calls[0]![1]!.headers as Record<string, string>).Authorization).toBe("Bearer t");
    const batch = buffer.batch(scope)!;
    expect(batch.records[0]).toMatchObject({ stage: "connection.relayed", addrType: "relay" });
    expect(batch.records.at(-1)).toMatchObject({ stage: "timing.dropped", count: 4 });

    await new MobileTimingBuffer().drain(endpoint, vi.fn<typeof fetch>(async () => new Response("not found", { status: 404 })));
  });

  it("refuses a malformed loopback answer and leaves the cursor where it was", async () => {
    const buffer = new MobileTimingBuffer();
    for (const bad of [{ records: [] }, { records: "x", next: 1 }, { next: -1 }]) {
      await expect(buffer.drain(endpoint, vi.fn<typeof fetch>(async () => Response.json(bad)))).rejects.toThrow("invalid_response");
    }
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ records: [], next: 0 }));
    await buffer.drain(endpoint, fetcher);
    expect(String(fetcher.mock.calls[0]![0])).toContain("after=0");
  });

  it("parses the executor's answer strictly enough that only success clears a batch", () => {
    expect(reportAckSchema.parse({ accepted: 2 })).toEqual({ accepted: 2, rejected: 0, duplicate: false });
    for (const bad of [{}, { accepted: -1 }, { accepted: "2" }, null]) expect(reportAckSchema.safeParse(bad).success).toBe(false);
    expect(diagnosticsSchema.parse({ next: 0 })).toEqual({ records: [], next: 0, dropped: 0 });
  });
});

describe("model catalog from the executor", () => {
  it("reads the default mark and tolerates a daemon without one", () => {
    expect(modelsSchema.parse({ supported: true, models: [{ id: "a", label: "A", isDefault: true }, { id: "b", label: "B" }] }).models.map((model) => model.isDefault)).toEqual([true, undefined]);
    expect(modelsSchema.safeParse({ models: [{ id: "a", label: "A", isDefault: "yes" }] }).success).toBe(false);
  });
});
