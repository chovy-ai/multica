// @vitest-environment node
import { autorun } from "mobx";
import { describe, expect, it } from "vitest";
import { localV2EventSchema, localV2SnapshotSchema } from "@multica/core/local-conversation/v2";
import { localSubmissionSchema } from "@multica/core/local-conversation/submission";
import { ConversationModel } from "./conversation-model";

describe("paging and retained conversations", () => {
  const at = "2026-11-03T10:00:00Z";
  const summary = { conversation_id: "c", summary_seq: 1, provider: "codex", title: "c", status: "idle", pinned: false, archived: false, updated_at: at };
  const event = (seq: number, type: string, fields: Record<string, unknown> = {}) => ({ seq, turn_id: "t5", turn_seq: seq, item_id: "x", type, final: type === "item.completed", created_at: at, payload: { kind: "background_task" }, ...fields });
  const turn = (index: number, events: unknown[] = []) => ({ id: `t${index}`, turn_index: index, request_id: "", status: "completed", started_at: at, completed_at: at, messages: [], events });
  const snapshot = (fields: Record<string, unknown> = {}) => localV2SnapshotSchema.parse({ version: 2, store_generation: "g", snapshot_seq: 100, conversation: summary, turns: [turn(5)], has_older_turns: true, pending_interactions: [], ...fields });

  it("does not apply an item's events twice when a late page repeats what the stream delivered", () => {
    const conversation = ConversationModel.fromSnapshot(snapshot());
    conversation.applyEvents([event(101, "item.started"), event(102, "item.delta", { payload: { field: "output", text: "ab" } })] as never);
    conversation.mergeHistory({ store_generation: "g", has_older_turns: false, turns: [turn(4, [event(101, "item.started"), event(102, "item.delta", { payload: { field: "output", text: "ab" } })])] } as never);
    expect(conversation.items.get("x")!.output).toBe("ab");
  });

  it("keeps a final state when an older event of the item arrives after it", () => {
    const conversation = ConversationModel.fromSnapshot(snapshot());
    conversation.applyEvents([event(101, "item.completed", { payload: { kind: "background_task", status: "completed", output: "done" } })] as never);
    conversation.mergeHistory({ store_generation: "g", has_older_turns: false, turns: [turn(4, [event(50, "item.delta", { payload: { field: "output", text: "partial" } })])] } as never);
    expect(conversation.items.get("x")!.output).toBe("done");
  });

  it("orders turns by index and never moves the cursor when paging", () => {
    const conversation = ConversationModel.fromSnapshot(snapshot());
    conversation.mergeHistory({ store_generation: "g", has_older_turns: true, turns: [turn(3), turn(4)] } as never);
    expect([...conversation.turns.keys()]).toEqual(["t3", "t4", "t5"]);
    expect(conversation.seq).toBe(100);
    expect(conversation.oldestTurnIndex()).toBe(3);
    expect(conversation.hasOlderTurns).toBe(true);
  });

  it("learns an item's kind from a later event when its first was a delta", () => {
    const conversation = ConversationModel.fromSnapshot(snapshot());
    conversation.applyEvents([event(101, "item.delta", { payload: { field: "output", text: "a" } }), event(102, "item.updated", { payload: { kind: "background_task", status: "in_progress" } })] as never);
    expect(conversation.items.get("x")!.kind).toBe("background_task");
  });

  it("keeps an item's start from a settled turn's final event", () => {
    const conversation = ConversationModel.fromSnapshot(snapshot({ turns: [turn(5, [event(9, "item.completed", { first_seq: 3, first_at: "2026-11-03T09:00:00Z" })])] }));
    expect(conversation.items.get("x")).toMatchObject({ order: 3, startedAt: "2026-11-03T09:00:00Z" });
  });

  it("retains paged history only when the new snapshot continues it", () => {
    const paged = () => {
      const model = ConversationModel.fromSnapshot(snapshot());
      model.mergeHistory({ store_generation: "g", has_older_turns: false, turns: [turn(3), turn(4)] } as never);
      return model;
    };
    const continuing = paged();
    continuing.replaceSnapshot(snapshot({ turns: [turn(5), turn(6)] }));
    expect([...continuing.turns.keys()]).toEqual(["t3", "t4", "t5", "t6"]);
    expect(continuing.hasOlderTurns).toBe(true);
    const distant = paged();
    distant.replaceSnapshot(snapshot({ turns: [turn(40)] }));
    expect([...distant.turns.keys()]).toEqual(["t40"]);
    const otherStore = paged();
    otherStore.replaceSnapshot(snapshot({ store_generation: "other", turns: [turn(5)] }));
    expect([...otherStore.turns.keys()]).toEqual(["t5"]);
  });

  it("drops a retained turn with an unfinished item, which could never finish", () => {
    const next = ConversationModel.fromSnapshot(snapshot());
    next.mergeHistory({ store_generation: "g", has_older_turns: false, turns: [turn(3), turn(4, [{ ...event(10, "item.started"), turn_id: "t4" }])] } as never);
    next.replaceSnapshot(snapshot());
    expect([...next.turns.keys()]).toEqual(["t5"]);
    expect(next.hasOlderTurns).toBe(true);
  });

  it("keeps queue revisions monotonic and marks items stale until they are read", () => {
    const conversation = ConversationModel.fromSnapshot(snapshot({ queue: { revision: 5, paused: false, error: "old", dispatching_request_id: "r", items: [{ request_id: "a" }] } }));
    expect(conversation.settings).toMatchObject({ permission_mode: "default" });
    const queued = (seq: number, payload: Record<string, unknown>) => ({ seq, turn_id: null, turn_seq: null, item_id: null, type: "queue.updated", final: false, created_at: at, payload });
    conversation.applyEvents([queued(101, { revision: 4, paused: true, count: 9 })] as never);
    expect(conversation.queue).toMatchObject({ revision: 5, paused: false });
    conversation.applyEvents([queued(102, { revision: 6, paused: false, count: 0 })] as never);
    expect(conversation.queue.error).toBeUndefined();
    expect(conversation.queueItemsStale()).toBe(true);
    conversation.receiveQueue({ revision: 6, paused: false, items: [] });
    expect(conversation.queueItemsStale()).toBe(false);
    expect(conversation.queue.items).toEqual([]);
    conversation.receiveQueue({ revision: 2, paused: true, items: [{ request_id: "stale" }] });
    expect(conversation.queue.items).toEqual([]);
  });

  it("clears the dispatching flag when the turn starts, since no other event does", () => {
    const conversation = ConversationModel.fromSnapshot(snapshot({ queue: { revision: 5, paused: false, dispatching_request_id: "r", items: [] } }));
    conversation.applyEvents([{ seq: 101, turn_id: "t6", turn_seq: 1, item_id: null, type: "turn.started", final: false, created_at: at, payload: { request_id: "r" } }] as never);
    expect(conversation.queue.dispatchingRequestId).toBeUndefined();
    expect(conversation.turns.get("t6")!.index).toBe(6);
  });

  it("resets in place on a new snapshot, so whoever holds the model sees it", () => {
    const conversation = ConversationModel.fromSnapshot(snapshot());
    conversation.applyEvents([event(101, "item.started")] as never);
    const seen: unknown[] = [];
    const stop = autorun(() => seen.push([...conversation.turns.keys()]));
    conversation.replaceSnapshot(snapshot({ snapshot_seq: 200, turns: [turn(5), turn(6)], queue: { revision: 3, paused: true, items: [] } }));
    stop();
    expect(seen).toEqual([["t5"], ["t5", "t6"]]);
    expect(conversation.seq).toBe(200);
    expect(conversation.items.size).toBe(0);
    expect(conversation.queue).toMatchObject({ revision: 3, paused: true });
  });

  it("tells an observer of one item about its own delta only", () => {
    const conversation = ConversationModel.fromSnapshot(snapshot());
    conversation.applyEvents([event(101, "item.started"), { ...event(102, "item.started"), item_id: "y" }] as never);
    const item = conversation.items.get("x")!;
    const other = conversation.items.get("y")!;
    const texts: string[] = [];
    const others: string[] = [];
    const stops = [autorun(() => texts.push(item.text)), autorun(() => others.push(other.text))];
    conversation.applyEvents([event(103, "item.delta", { payload: { field: "text", text: "a" } }), event(104, "item.delta", { payload: { field: "text", text: "b" } })] as never);
    for (const stop of stops) stop();
    // One batch is one notification.
    expect(texts).toEqual(["", "ab"]);
    expect(others).toEqual([""]);
  });

  it("replaces an item's whole state on a final event, leaving no old field behind", () => {
    const conversation = ConversationModel.fromSnapshot(snapshot());
    conversation.applyEvents([
      event(101, "item.started", { payload: { kind: "reasoning", text: "first", tool: "old" } }),
      event(102, "item.delta", { payload: { field: "text", text: " more" } }),
    ] as never);
    expect(conversation.items.get("x")).toMatchObject({ text: "first more", state: { kind: "reasoning", tool: "old" } });
    conversation.applyEvents([event(103, "item.completed", { payload: { kind: "reasoning" } })] as never);
    expect(conversation.items.get("x")).toMatchObject({ text: "", state: { kind: "reasoning" } });
    expect(conversation.items.get("x")!.state).not.toHaveProperty("tool");
  });
});

describe("dispatch state follows the current execution", () => {
  const at = "2026-11-14T05:00:00Z";
  const queue = (id = "request") => ({ revision: 2, paused: false, items: [], dispatching_request_id: id });
  const turn = (status = "running", requestId = "request") => ({
    id: `turn-${requestId}`, turn_index: 0, request_id: requestId, status, started_at: at, messages: [], events: [],
  });
  const snapshot = (fields: Record<string, unknown> = {}) => localV2SnapshotSchema.parse({
    version: 2, store_generation: "g", snapshot_seq: 10, queue: queue(),
    conversation: { conversation_id: "side", summary_seq: 1, provider: "claude", title: "Side", status: "idle", pinned: false, archived: false, updated_at: at },
    turns: [], ...fields,
  });
  const started = (seq: number, requestId = "request") => localV2EventSchema.parse({
    seq, type: "turn.started", turn_id: `turn-${requestId}`, final: false, created_at: at, payload: { request_id: requestId },
  });
  const submission = (state: "starting" | "attached", requestId = "request", revision = 1) => localSubmissionSchema.parse({
    request_id: "request", revision, state,
    attempt: { attempt_id: `attempt-${requestId}`, request_id: requestId, turn_ids: state === "attached" ? [`turn-${requestId}`] : [], delivery: "not_sent" },
  });

  it.each(["running", "completed"])("ignores a late queue read after a turn is %s", (status) => {
    const model = ConversationModel.fromSnapshot(snapshot());
    model.applyEvents([started(11)]);
    if (status === "completed") model.applyEvents([localV2EventSchema.parse({
      seq: 12, type: "turn.completed", turn_id: "turn-request", final: true, created_at: at, payload: { status },
    })]);
    model.receiveQueue(queue());
    expect(model.queue.dispatchingRequestId).toBeUndefined();
    expect(model.turns.get("turn-request")?.status).toBe(status);
  });

  it.each(["initial", "replacement", "stale"])("reconciles dispatching in an %s snapshot", (source) => {
    const value = snapshot({ turns: [turn("completed")] });
    const model = ConversationModel.fromSnapshot(source === "initial" ? value : snapshot({ turns: value.turns, snapshot_seq: source === "stale" ? 11 : 9 }));
    if (source !== "initial") model.replaceSnapshot(value);
    expect(model.queue.dispatchingRequestId).toBeUndefined();
    expect(model.turns.get("turn-request")?.status).toBe("completed");
  });

  it("retains the next request's dispatching while another turn starts and completes", () => {
    const model = ConversationModel.fromSnapshot(snapshot({ queue: queue("next") }));
    model.applyEvents([started(11), localV2EventSchema.parse({
      seq: 12, type: "turn.completed", turn_id: "turn-request", final: true, created_at: at, payload: { status: "completed" },
    })]);
    expect(model.queue.dispatchingRequestId).toBe("next");
  });

  it("uses a retry's current attempt instead of a previous turn of the same message", () => {
    const model = ConversationModel.fromSnapshot(snapshot({ turns: [turn("failed")], submissions: [submission("starting", "retry")] }));
    expect(model.queue.dispatchingRequestId).toBe("request");
    model.mergeHistory({ store_generation: "g", has_older_turns: false, turns: [snapshot({ turns: [turn("failed")] }).turns[0]!] });
    expect(model.queue.dispatchingRequestId).toBe("request");
    model.applyEvents([started(11, "retry")]);
    expect(model.queue.dispatchingRequestId).toBeUndefined();
    model.receiveQueue(queue());
    expect(model.queue.dispatchingRequestId).toBeUndefined();
  });

  it.each(["snapshot", "event", "read"])("clears an attached attempt from a %s even when its turn is not loaded", (source) => {
    const attached = submission("attached");
    const model = ConversationModel.fromSnapshot(snapshot({ submissions: source === "snapshot" ? [attached] : [] }));
    if (source === "event") model.applyEvents([localV2EventSchema.parse({
      seq: 11, type: "submission.updated", final: false, created_at: at, payload: { submission: attached, queue_revision: 2 },
    })]);
    if (source === "read") model.mergeSubmissions([attached]);
    expect(model.turns.size).toBe(0);
    expect(model.queue.dispatchingRequestId).toBeUndefined();
  });

  it("keeps a new retry dispatching when an older submission reply arrives", () => {
    const model = ConversationModel.fromSnapshot(snapshot({ turns: [turn("failed")], submissions: [submission("attached")] }));
    model.mergeSubmissions([submission("starting", "retry", 2)]);
    model.receiveQueue(queue());
    model.mergeSubmissions([submission("attached")]);
    expect(model.queue.dispatchingRequestId).toBe("request");
  });

  it("forgets execution evidence when the store is replaced", () => {
    const model = ConversationModel.fromSnapshot(snapshot({ turns: [turn("completed")], submissions: [submission("attached")] }));
    model.replaceSnapshot(snapshot({ store_generation: "new-store" }));
    expect(model.queue.dispatchingRequestId).toBe("request");
  });
});
