import assert from "node:assert/strict";
import test from "node:test";
import { resolveIssueManagerFloatingNoticeViewState } from "./IssueManagerNoticeState.ts";

test("floating notice state returns null when there is no notification", () => {
  assert.equal(
    resolveIssueManagerFloatingNoticeViewState({
      notification: null
    }),
    null
  );
});

test("floating notice state returns a transient single-line notice model", () => {
  assert.deepEqual(
    resolveIssueManagerFloatingNoticeViewState({
      notification: {
        id: 7,
        title: "messages.runFailed",
        tone: "destructive"
      }
    }),
    {
      durationMs: 3000,
      id: 7,
      isLoading: false,
      title: "messages.runFailed",
      tone: "destructive"
    }
  );
});
