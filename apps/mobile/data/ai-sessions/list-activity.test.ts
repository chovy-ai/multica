// @vitest-environment node
import { expect, it } from "vitest";
import { localV2SummarySchema } from "@multica/core/local-conversation/v2";
import { sessionListActivity } from "./list-activity";

const summary = (status: string, background_tasks = 0, pending_interactions = 0) => localV2SummarySchema.parse({
  conversation_id: "unselected", summary_seq: 1, provider: "codex", title: "Conversation",
  status, background_tasks, pending_interactions, pinned: false, archived: false, updated_at: "2026-11-08",
});

it("shows foreground activity before background tasks and distinguishes waiting for an answer", () => {
  expect(sessionListActivity(summary("running"))).toBe("session_running");
  expect(sessionListActivity(summary("running", 2))).toBe("session_running");
  expect(sessionListActivity(summary("running", 2, 1))).toBe("pending_question");
  expect(sessionListActivity(summary("idle", 2))).toBe("session_background");
});

it.each(["idle", "completed", "failed", "cancelled", "future-status"])("clears foreground activity for %s without losing live background tasks", (status) => {
  expect(sessionListActivity(summary(status, 0, 1))).toBeNull();
  expect(sessionListActivity(summary(status, 1))).toBe("session_background");
});

it("ignores unread results, queued messages, and stale turn IDs when the summary is idle", () => {
  const idle = { ...summary("idle"), has_unread_completion: true, queue_count: 2, active_turn_id: "old" };
  expect(sessionListActivity(idle)).toBeNull();
});
