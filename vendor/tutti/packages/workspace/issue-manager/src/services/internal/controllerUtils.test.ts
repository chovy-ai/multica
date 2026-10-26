import assert from "node:assert/strict";
import test from "node:test";
import type {
  IssueManagerIssueSummary,
  IssueManagerTaskSummary
} from "../../contracts/index.ts";
import type { IssueManagerI18nRuntime } from "../../i18n/issueManagerI18n.ts";
import {
  resolveIssueManagerErrorMessage,
  resolveIssueManagerSelectedIssueId,
  resolveIssueManagerSelectedTaskId,
  resolveIssueManagerTopicDeleteErrorMessage
} from "./controllerUtils.ts";

test("resolveIssueManagerSelectedIssueId keeps valid selections and falls back to the first issue", () => {
  const issues: IssueManagerIssueSummary[] = [
    {
      creatorUserId: "local",
      issueId: "issue-1",
      status: "running",
      title: "Plan migration",
      topicId: "topic-1",
      workspaceId: "workspace-1"
    },
    {
      creatorUserId: "local",
      issueId: "issue-2",
      status: "not_started",
      title: "Port renderer",
      topicId: "topic-1",
      workspaceId: "workspace-1"
    }
  ];

  assert.equal(resolveIssueManagerSelectedIssueId(null, issues), "issue-1");
  assert.equal(
    resolveIssueManagerSelectedIssueId("issue-2", issues),
    "issue-2"
  );
  assert.equal(
    resolveIssueManagerSelectedIssueId("missing-issue", issues),
    "issue-1"
  );
  assert.equal(resolveIssueManagerSelectedIssueId("issue-1", []), null);
});

test("resolveIssueManagerSelectedTaskId keeps valid selections without defaulting to the first task", () => {
  const tasks: IssueManagerTaskSummary[] = [
    {
      creatorUserId: "local",
      issueId: "issue-1",
      priority: "medium",
      status: "running",
      taskId: "task-1",
      title: "Draft migration plan",
      workspaceId: "workspace-1"
    },
    {
      creatorUserId: "local",
      issueId: "issue-1",
      priority: "high",
      status: "not_started",
      taskId: "task-2",
      title: "Port renderer",
      workspaceId: "workspace-1"
    }
  ];

  assert.equal(resolveIssueManagerSelectedTaskId(null, tasks), null);
  assert.equal(resolveIssueManagerSelectedTaskId("task-2", tasks), "task-2");
  assert.equal(resolveIssueManagerSelectedTaskId("missing-task", tasks), null);
  assert.equal(resolveIssueManagerSelectedTaskId("task-1", []), null);
});

test("resolveIssueManagerErrorMessage localizes structured run errors", () => {
  const copy = {
    t(key: string, params?: Record<string, string>) {
      if (key === "messages.runExitCode") {
        return `Codex exit code: ${params?.code}`;
      }
      return key;
    }
  } as IssueManagerI18nRuntime;

  assert.equal(
    resolveIssueManagerErrorMessage("issue_manager.run_exit_code:17", copy),
    "Codex exit code: 17"
  );
  assert.equal(
    resolveIssueManagerErrorMessage("issue_manager.run_timed_out", copy),
    "messages.runTimedOut"
  );
  assert.equal(
    resolveIssueManagerErrorMessage(
      "issue_manager.clipboard_unavailable",
      copy
    ),
    "messages.clipboardUnavailable"
  );
  assert.equal(
    resolveIssueManagerErrorMessage(new Error("network failed"), copy),
    "network failed"
  );
  assert.equal(
    resolveIssueManagerErrorMessage(
      new Error("network failed"),
      copy,
      "messages.runFailed"
    ),
    "messages.runFailed"
  );
});

test("resolveIssueManagerTopicDeleteErrorMessage localizes protocol reasons", () => {
  const copy = {
    t(key: string) {
      return key;
    }
  } as IssueManagerI18nRuntime;

  assert.equal(
    resolveIssueManagerTopicDeleteErrorMessage(
      {
        code: "workspace_issue_resource_exists",
        reason: "workspace_issue_topic_not_empty"
      },
      copy
    ),
    "messages.topicDeleteNotEmpty"
  );
  assert.equal(
    resolveIssueManagerTopicDeleteErrorMessage(
      {
        error: {
          code: "workspace_issue_resource_not_found",
          reason: "workspace_issue_topic_not_found"
        }
      },
      copy
    ),
    "messages.topicDeleteNotFound"
  );
  assert.equal(
    resolveIssueManagerTopicDeleteErrorMessage(
      {
        code: "invalid_request",
        reason: "malformed_request"
      },
      copy
    ),
    "messages.topicDeleteDefaultForbidden"
  );
  assert.equal(
    resolveIssueManagerTopicDeleteErrorMessage(
      new Error("network failed"),
      copy
    ),
    "messages.topicDeleteFailed"
  );
});
