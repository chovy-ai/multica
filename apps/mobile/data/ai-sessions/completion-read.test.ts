// @vitest-environment node
import { expect, it } from "vitest";
import { localV2SnapshotSchema } from "@multica/core/local-conversation/v2";
import { shownCompletion } from "./completion-read";

const snapshot = () => localV2SnapshotSchema.parse({
  version: 2, store_generation: "g", snapshot_seq: 4,
  conversation: { conversation_id: "c", summary_seq: 2, provider: "claude", title: "c", status: "idle", pinned: false, archived: false, updated_at: "now",
    completion: { turn_id: "a", turn_index: 0, completion_seq: 1 }, read_turn_index: -1, read_completion_seq: 0, has_unread_completion: true },
  turns: [{ id: "a", turn_index: 0, status: "completed", started_at: "now", messages: [], events: [] }],
});
it("captures exactly the successfully rendered result version", () => {
  const s = snapshot();
  const position = shownCompletion(s, ["a"], true);
  expect(position).toEqual({ store_generation: "g", turn_id: "a", turn_index: 0, completion_seq: 1 });
  s.conversation.completion = { turn_id: "b", turn_index: 1, completion_seq: 2 };
  expect(position?.turn_id).toBe("a");
  expect(shownCompletion(s, ["a"], true)).toBeNull();
});
it("does not acknowledge background, offscreen, missing, already-read or unsuccessful results", () => {
  expect(shownCompletion(undefined, ["a"], true)).toBeNull();
  expect(shownCompletion(snapshot(), ["a"], false)).toBeNull();
  expect(shownCompletion(snapshot(), ["old-history"], true)).toBeNull();
  const read = snapshot(); read.conversation.read_turn_index = 0; read.conversation.read_completion_seq = 1;
  expect(shownCompletion(read, ["a"], true)).toBeNull();
  for (const status of ["running", "failed", "cancelled", "future"]) {
    const s = snapshot(); s.turns[0].status = status;
    expect(shownCompletion(s, ["a"], true)).toBeNull();
  }
  const unknown = snapshot(); delete unknown.conversation.read_completion_seq;
  expect(shownCompletion(unknown, ["a"], true)).toBeNull();
});
