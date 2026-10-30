// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { localV2EventSchema, localV2SnapshotSchema } from "@multica/core/local-conversation/v2";
import { QueryClient } from "@tanstack/react-query";
import { AISessionClient, aiKeys } from "./client";
import { applyEvents, retainSnapshotHistory } from "./projection";
import { attachmentMetadataSchema, historySchema, remainingUsage, usageSchema } from "./schemas";
import { remoteWebURL } from "./files";

vi.mock("expo", () => ({ requireOptionalNativeModule: () => null }));
const snapshot = (indices: number[], seq: number, generation = "store-a") => localV2SnapshotSchema.parse({ version: 2, store_generation: generation, snapshot_seq: seq,
  conversation: { conversation_id: "conversation", summary_seq: 1, provider: "codex", title: "Test", status: "idle", pinned: false, archived: false, updated_at: "now" }, has_older_turns: indices[0] > 0,
  turns: indices.map((index) => ({ id: `turn-${index}`, turn_index: index, status: "completed", started_at: "now", messages: [], events: [] })) });

describe("provider limits", () => {
  it("distinguishes expired and unreported windows from zero remaining", () => {
    expect(remainingUsage(100, null)).toBe(0);
    expect(remainingUsage(28, "2020-01-01")).toBeNull();
    expect(remainingUsage(28, "not-a-date")).toBeNull();
    expect(remainingUsage(28, null)).toBe(72);
    const unknown = usageSchema.parse({ provider: "claude", context: { used_tokens: null, limit_tokens: null, model: null, updated_at: null }, account: { status: "unavailable", plan: null, windows: [], updated_at: null } });
    expect(unknown.account.windows).toEqual([]);
    expect(usageSchema.safeParse({ provider: "codex", account: { windows: [{ used_percent: "58" }] } }).success).toBe(false);
    expect(attachmentMetadataSchema.safeParse({ name: "guide.pdf", mime_type: "application/pdf", size: -1 }).success).toBe(false);
  });
});

it("reads authoritative queue items after receiving a count-only event", async () => {
  const scope = { userId: "user", workspaceId: "workspace", deviceId: "device" };
  const qc = new QueryClient();
  qc.setQueryData(aiKeys.snapshot(scope, "conversation"), snapshot([], 0));
  const queue = { revision: 1, paused: false, items: [{ requestId: "queued", content: "Follow up" }] };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(queue));
  const client = new AISessionClient({ url: "http://127.0.0.1:1234", token: "private" }, scope, qc, () => { throw new Error("Unexpected socket"); }, fetcher);
  client.receive({ version: 2, type: "conversation.events", conversation_id: "conversation", from_seq: 1, to_seq: 1, events: [{ seq: 1, type: "queue.updated", final: false, turn_id: null, item_id: null, payload: { revision: 1, paused: false, count: 1 }, created_at: "now" }] });
  await vi.waitFor(() => expect(qc.getQueryData(aiKeys.snapshot(scope, "conversation"))).toMatchObject({ queue }));
  expect(fetcher.mock.calls[0][0]).toContain("/sessions/conversation/queue");
  client.close(); qc.clear();
});

describe("history and queue reconciliation", () => {
  it("retains already-read history while accepting newer turn state", () => {
    const old = snapshot([20, 21, 22], 10);
    const next = snapshot([21, 22, 23], 15);
    expect(retainSnapshotHistory(old, next).turns.map((turn) => turn.turn_index)).toEqual([20, 21, 22, 23]);
    expect(retainSnapshotHistory(next, old)).toBe(next);
    expect(retainSnapshotHistory(old, snapshot([21, 22], 0, "replaced-store")).turns).toHaveLength(2);
    expect(retainSnapshotHistory(old, snapshot([100, 101], 200)).turns.map((turn) => turn.turn_index)).toEqual([100, 101]);
    expect(historySchema.safeParse({ turns: [], has_older_turns: false }).success).toBe(false);
  });
  it("keeps queue items when a live notification only carries a count", () => {
    const old = snapshot([], 0);
    old.queue = { revision: 1, paused: false, items: [{ requestId: "pending", content: "Follow up" }] };
    const event = localV2EventSchema.parse({ seq: 1, type: "queue.updated", final: false, turn_id: null, item_id: null, payload: { revision: 2, paused: true, count: 1 }, created_at: "now" });
    const next = applyEvents(old, [event])!;
    expect(next.queue).toMatchObject({ revision: 2, paused: true, items: old.queue.items });
    expect(next.conversation.queue_count).toBe(1);
    expect(next.turns).toEqual([]);
    expect(old.queue.paused).toBe(false);
  });
});

it("opens public URLs without treating the computer's loopback as the phone", () => {
  for (const url of ["http://localhost:3000", "http://127.0.0.1:8080", "http://[::1]:3000", "http://127.1:3000", "file:///etc/passwd", "https://user:secret@example.com", "javascript:alert(1)"]) expect(remoteWebURL(url)).toBeNull();
  expect(remoteWebURL("https://example.com/path?q=1")).toBe("https://example.com/path?q=1");
});
