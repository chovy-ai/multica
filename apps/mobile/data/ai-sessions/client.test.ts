// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { localV2EventSchema, localV2SnapshotSchema, localV2SummarySchema } from "@multica/core/local-conversation/v2";
import { AISessionClient, aiKeys } from "./client";
import { applyEvents, groupSessions, transcript, visibleSessions } from "./projection";

const scope = { userId: "user-a", workspaceId: "workspace-a", deviceId: "peer-a" };
const summary = (id = "session-a", seq = 1) => localV2SummarySchema.parse({ conversation_id: id, summary_seq: seq, provider: "codex", title: id, status: "idle", pinned: false, archived: false, updated_at: "2026-10-30T12:00:00Z" });
const snapshot = () => localV2SnapshotSchema.parse({ version: 2, store_generation: "generation-a", snapshot_seq: 0, conversation: summary(), turns: [] });
const event = (seq: number, type: string, payload: Record<string, unknown>, item: string | null = null) => localV2EventSchema.parse({ seq, type, payload, turn_id: "turn-a", item_id: item, final: type.endsWith("completed"), created_at: "2026-10-30T12:00:00Z" });
const unusedSocket = () => { throw new Error("Unexpected socket in a cache test"); };

afterEach(() => vi.useRealTimers());

describe("mobile AI session event projection", () => {
  it("streams text once, accepts authoritative final text, and ignores duplicate events", () => {
    const initial = snapshot();
    const events = [event(1, "turn.started", { request_id: "send-a" }), event(2, "user.message", { message_id: "user-message", content: "hello" }),
      event(3, "item.started", { kind: "assistant_text" }, "answer"), event(4, "item.delta", { kind: "assistant_text", field: "text", text: "Hel" }, "answer"),
      event(5, "item.delta", { kind: "assistant_text", field: "text", text: "lo" }, "answer")];
    const streamed = applyEvents(initial, events)!;
    expect(transcript(streamed).map((row) => row.content)).toEqual(["hello", "Hello"]);
    expect(initial.snapshot_seq).toBe(0);
    const final = applyEvents(streamed, [events[4], event(6, "item.completed", { kind: "assistant_text", text: "Hello!" }, "answer"), event(7, "turn.completed", { status: "completed" })])!;
    expect(transcript(final).map((row) => row.content)).toEqual(["hello", "Hello!"]);
    expect(final.turns[0].status).toBe("completed");
  });

  it("requests a fresh snapshot on a sequence gap and keeps the old snapshot unchanged", () => {
    const initial = snapshot();
    expect(applyEvents(initial, [event(2, "turn.started", {})])).toBeNull();
    expect(initial.turns).toEqual([]);
  });

  it("does not duplicate persisted assistant rows and execution text", () => {
    const value = applyEvents(snapshot(), [event(1, "item.completed", { kind: "assistant_text", text: "Answer" }, "answer")])!;
    value.turns[0].messages.push({ id: "persisted", role: "assistant", content: "Answer", attachment_ids: [], steered: false, failed: false, created_at: "now" });
    expect(transcript(value).filter((row) => row.role === "assistant")).toHaveLength(1);
  });

  it("removes answered questions without deleting transcript rows", () => {
    const pending = applyEvents(snapshot(), [event(1, "interaction.requested", { interaction_id: "question-a", kind: "question", request: { questions: [] } })])!;
    expect(pending.pending_interactions).toHaveLength(1);
    expect(applyEvents(pending, [event(2, "interaction.resolved", { interaction_id: "question-a" })])!.pending_interactions).toEqual([]);
  });

  it("applies metadata and model changes made from another device", () => {
    const updated = applyEvents(snapshot(), [event(1, "conversation.updated", { title: "Renamed", archived: true, model: "model-b" })])!;
    expect(updated.conversation).toMatchObject({ title: "Renamed", archived: true });
    expect(updated.settings.model).toBe("model-b");
  });

  it("filters archived and searched sessions while keeping pinned sessions first", () => {
    const pinned = { ...summary("pinned"), pinned: true };
    const archived = { ...summary("old"), archived: true };
    expect(visibleSessions([summary(), archived, pinned], "", false).map((s) => s.conversation_id)).toEqual(["pinned", "session-a"]);
    expect(visibleSessions([summary(), archived], "old", true)).toEqual([archived]);
  });

  it("groups by the computer's working directory rather than cloud project associations", () => {
    const session = { ...summary(), cwd: "/work/repo/", project_id: "cloud-project" };
    const groups = groupSessions([session], [{ id: "folder-project", title: "Repository", path: "/work/repo" }], "Repository", false, "Other");
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("folder-project");
    expect(groups[0].data).toEqual([session]);
    expect(groupSessions([], [{ id: "folder-project", title: "Repository", path: "/work/repo" }], "", false, "Other")).toHaveLength(2);
  });
});

describe("mobile AI session transport and caches", () => {
  it("partitions caches by account, workspace and device", () => {
    const base = aiKeys.snapshot(scope, "same-session");
    for (const changed of [{ userId: "b" }, { workspaceId: "b" }, { deviceId: "b" }]) expect(aiKeys.snapshot({ ...scope, ...changed }, "same-session")).not.toEqual(base);
  });

  it("reads every list page and uses only the native loopback credential", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ summaries: [summary()], scope_seq: 1, has_more: true }))
      .mockResolvedValueOnce(Response.json({ summaries: [summary("session-b", 2)], scope_seq: 2, has_more: false }));
    const client = new AISessionClient({ url: "http://127.0.0.1:1234", token: "loopback" }, scope, new QueryClient(), unusedSocket, fetcher);
    expect(await client.list()).toHaveLength(2);
    expect(fetcher.mock.calls[1][0]).toContain("after_scope_seq=1");
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer loopback", "X-Workspace-ID": "workspace-a" });
    client.close();
  });

  it("rejects malformed successes and forwards caller cancellation", async () => {
    const controller = new AbortController(); controller.abort();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ version: 2 }));
    const client = new AISessionClient({ url: "http://127.0.0.1:1234", token: "loopback" }, scope, new QueryClient(), unusedSocket, fetcher);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(client.snapshot("session-a", controller.signal)).rejects.toThrow("invalid_response");
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    warning.mockRestore(); client.close();
  });

  it("ignores stale summary echoes and applies events only to the matching device cache", () => {
    const qc = new QueryClient();
    const client = new AISessionClient({ url: "http://127.0.0.1:1234", token: "loopback" }, scope, qc, unusedSocket);
    qc.setQueryData(aiKeys.list(scope), [summary("session-a", 3)]);
    qc.setQueryData(aiKeys.snapshot(scope, "session-a"), snapshot());
    const other = { ...scope, deviceId: "other-peer" };
    qc.setQueryData(aiKeys.snapshot(other, "session-a"), snapshot());
    client.receive({ version: 2, type: "scope.summaries", scope_seq: 1, summaries: [summary("session-a", 1)] });
    expect(qc.getQueryData(aiKeys.list(scope))).toEqual([summary("session-a", 3)]);
    client.receive({ version: 2, type: "conversation.events", conversation_id: "session-a", from_seq: 1, to_seq: 1, events: [event(1, "turn.started", {})] });
    expect(qc.getQueryData(aiKeys.snapshot(other, "session-a"))).toEqual(snapshot());
    expect(qc.getQueryData(aiKeys.snapshot(scope, "session-a"))).toMatchObject({ snapshot_seq: 1 });
    client.close(); qc.clear();
  });

  it("reloads and resubscribes after a gap without overwriting cache after close", async () => {
    let resolve!: (res: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise((done) => { resolve = done; }));
    const qc = new QueryClient();
    qc.setQueryData(aiKeys.snapshot(scope, "session-a"), snapshot());
    const client = new AISessionClient({ url: "http://127.0.0.1:1234", token: "loopback" }, scope, qc, unusedSocket, fetcher);
    client.receive({ version: 2, type: "conversation.events", conversation_id: "session-a", from_seq: 5, to_seq: 5, events: [event(5, "turn.started", {})] });
    expect(fetcher).toHaveBeenCalledOnce();
    client.close(); resolve(Response.json({ ...snapshot(), snapshot_seq: 10 }));
    await new Promise((done) => setTimeout(done, 0));
    expect(qc.getQueryData(aiKeys.snapshot(scope, "session-a"))).toMatchObject({ snapshot_seq: 0 });
    qc.clear();
  });
});
