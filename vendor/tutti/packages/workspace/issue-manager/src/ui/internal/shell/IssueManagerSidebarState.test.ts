import assert from "node:assert/strict";
import test from "node:test";
import { resolveIssueManagerSidebarPresentationState } from "./IssueManagerSidebarState.ts";

test("sidebar presentation state suppresses standalone content when the shell renders inline", () => {
  assert.deepEqual(
    resolveIssueManagerSidebarPresentationState({
      showStandaloneState: false,
      sidebarViewState: {
        kind: "error",
        retryLabel: "actions.refresh",
        title: "messages.issueRefreshFailed"
      }
    }),
    {
      kind: "none"
    }
  );
});

test("sidebar presentation state keeps retry metadata for standalone errors", () => {
  assert.deepEqual(
    resolveIssueManagerSidebarPresentationState({
      showStandaloneState: true,
      sidebarViewState: {
        kind: "error",
        retryLabel: "actions.refresh",
        title: "messages.issueRefreshFailed"
      }
    }),
    {
      kind: "error",
      retryLabel: "actions.refresh",
      title: "messages.issueRefreshFailed"
    }
  );
});

test("sidebar presentation state keeps empty copy for standalone empty states", () => {
  assert.deepEqual(
    resolveIssueManagerSidebarPresentationState({
      showStandaloneState: true,
      sidebarViewState: {
        body: "messages.noIssuesForFilterBody",
        kind: "empty",
        title: "messages.noIssuesForFilterTitle"
      }
    }),
    {
      body: "messages.noIssuesForFilterBody",
      kind: "empty"
    }
  );
});
