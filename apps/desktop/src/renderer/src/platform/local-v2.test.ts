// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { localV2SummarySchema, type LocalV2Transport } from "@multica/core/local-conversation/v2";
import { LocalV2ScopeClient, localV2Error } from "./local-v2";

const scope = { userId: "u", workspaceId: "w" };
const at = "2026-10-29T00:00:00Z";
const summary = (id: string, seq: number, title = id) => localV2SummarySchema.parse({ conversation_id: id, summary_seq: seq, provider: "claude", title, status: "idle", pinned: false, archived: false, updated_at: at });

function transport(pages: unknown[] = []) {
  const sent: unknown[] = [];
  const t: LocalV2Transport = {
    request: vi.fn(async () => pages.shift() ?? { scope_seq: 0, summaries: [], has_more: false }),
    send: vi.fn(async (_scope, message) => { sent.push(message); }),
    subscribe: vi.fn(() => () => {}), onConnection: vi.fn(() => () => {}),
    fileUrl: (_scope, path) => `file:${path}`, upload: vi.fn(),
  };
  return { t, sent };
}

describe("LocalV2ScopeClient", () => {
  it("loads every summary page, then follows the scope stream", async () => {
    const { t, sent } = transport([
      { scope_seq: 2, summaries: [summary("a", 1), summary("b", 2)], has_more: true },
      { scope_seq: 3, summaries: [summary("c", 3)], has_more: false },
    ]);
    const client = new LocalV2ScopeClient(t, scope);
    const changed = vi.fn();
    client.onSummaries(changed);
    await client.loadSummaries();
    expect(client.summaries().map((s) => s.conversation_id)).toEqual(["a", "b", "c"]);
    expect(sent).toEqual([{ version: 2, type: "subscribe_scope", after_scope_seq: 3 }]);
    client.receive({ version: 2, type: "scope.summaries", scope_seq: 4, summaries: [summary("a", 4, "renamed")] });
    expect(client.summary("a")?.title).toBe("renamed");
    // An older summary arriving late never replaces a newer one.
    client.receiveSummary(summary("a", 1, "stale"));
    expect(client.summary("a")?.title).toBe("renamed");
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("shares one subscription per conversation and reloads late joiners", async () => {
    const { t, sent } = transport();
    const client = new LocalV2ScopeClient(t, scope);
    const first = vi.fn(), second = vi.fn();
    const stopFirst = client.subscribe("c1", 3, "g", first);
    client.receive({ version: 2, type: "conversation.events", conversation_id: "c1", from_seq: 4, to_seq: 5, events: [
      { seq: 4, type: "turn.started", final: false, created_at: at, payload: {} },
      { seq: 5, type: "turn.completed", final: true, created_at: at, payload: {} },
    ] });
    expect(first).toHaveBeenCalledTimes(1);
    const stopSecond = client.subscribe("c1", 3, "g", second);
    await Promise.resolve();
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ status: "resubscribe" }));
    stopFirst(); stopSecond();
    expect(sent.filter((m: any) => m.type === "subscribe")).toHaveLength(1);
    expect(sent.at(-1)).toEqual({ version: 2, type: "unsubscribe", conversation_id: "c1" });
  });

  it("tells listeners to reload when the connection drops", () => {
    const { t } = transport();
    const client = new LocalV2ScopeClient(t, scope);
    const listener = vi.fn();
    client.subscribe("c1", 0, "g", listener);
    client.connection(false);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ conversation_id: "c1", status: "resubscribe" }));
  });

  it("keeps the daemon's error kind across IPC", () => {
    const error = localV2Error(new Error("Error invoking remote method 'local-v2:request': Error: turn_running: local conversation: a turn is already running"));
    expect(error.kind).toBe("turn_running");
    expect(error.message).toBe("local conversation: a turn is already running");
  });
});
