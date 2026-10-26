import assert from "node:assert/strict";
import test from "node:test";
import type {
  IssueManagerIssueSummary,
  IssueManagerTaskSummary,
  IssueManagerTopic
} from "../../../../contracts/index.ts";
import {
  dispatchIssueManagerTopicHeaderState,
  resolveIssueManagerTopicHeaderState,
  resolveIssueManagerSelectedIssue,
  resolveIssueManagerSelectedTask
} from "./IssueManagerNodeState.ts";

test("resolveIssueManagerSelectedIssue prefers loaded detail over sidebar list", () => {
  const listIssue = createIssueSummary({
    issueId: "issue-1",
    title: "List title"
  });
  const detailIssue = createIssueSummary({
    issueId: "issue-1",
    title: "Detail title"
  });

  assert.equal(
    resolveIssueManagerSelectedIssue({
      issueDetail: detailIssue,
      issues: [listIssue],
      selectedIssueId: "issue-1"
    }),
    detailIssue
  );
});

test("resolveIssueManagerSelectedIssue falls back to the sidebar list", () => {
  const listIssue = createIssueSummary({
    issueId: "issue-1",
    title: "Plan migration"
  });

  assert.equal(
    resolveIssueManagerSelectedIssue({
      issueDetail: null,
      issues: [listIssue],
      selectedIssueId: "issue-1"
    }),
    listIssue
  );
});

test("resolveIssueManagerSelectedTask prefers loaded task detail over issue task lists", () => {
  const listTask = createTaskSummary({
    issueId: "issue-1",
    taskId: "task-1",
    title: "List task"
  });
  const detailTask = createTaskSummary({
    issueId: "issue-1",
    taskId: "task-1",
    title: "Detail task"
  });

  assert.equal(
    resolveIssueManagerSelectedTask({
      selectedTaskId: "task-1",
      taskDetail: detailTask,
      tasks: [listTask]
    }),
    detailTask
  );
});

test("resolveIssueManagerSelectedTask falls back to tasks on the selected issue", () => {
  const listTask = createTaskSummary({
    issueId: "issue-1",
    taskId: "task-1",
    title: "Port renderer"
  });

  assert.equal(
    resolveIssueManagerSelectedTask({
      selectedTaskId: "task-1",
      taskDetail: null,
      tasks: [listTask]
    }),
    listTask
  );
});

test("topic header event hub replays state when header initializes late", () => {
  const topic = createTopic({
    topicId: "default",
    title: "default"
  });

  dispatchIssueManagerTopicHeaderState({
    activeTopicId: topic.topicId,
    nodeId: "late-header-node",
    topics: [topic],
    workspaceId: "workspace-1"
  });

  const state = resolveIssueManagerTopicHeaderState({
    activeTopicId: null,
    nodeId: "late-header-node",
    workspaceId: "workspace-1"
  });

  assert.equal(state.activeTopicId, "default");
  assert.deepEqual(state.topics, [topic]);
});

test("topic header event hub scopes replay by workspace and node", () => {
  const topic = createTopic({
    topicId: "workspace-1-topic",
    title: "workspace 1"
  });

  dispatchIssueManagerTopicHeaderState({
    activeTopicId: topic.topicId,
    nodeId: "issue-manager",
    topics: [topic],
    workspaceId: "workspace-1"
  });

  const otherWorkspaceState = resolveIssueManagerTopicHeaderState({
    activeTopicId: null,
    nodeId: "issue-manager",
    workspaceId: "workspace-2"
  });

  assert.equal(otherWorkspaceState.activeTopicId, null);
  assert.deepEqual(otherWorkspaceState.topics, []);
});

function createIssueSummary(
  input: Pick<IssueManagerIssueSummary, "issueId" | "title">
): IssueManagerIssueSummary {
  return {
    creatorUserId: "local",
    issueId: input.issueId,
    status: "not_started",
    title: input.title,
    topicId: "topic-1",
    workspaceId: "workspace-1"
  };
}

function createTopic(
  input: Pick<IssueManagerTopic, "topicId" | "title">
): IssueManagerTopic {
  return {
    isDefault: input.topicId === "default",
    summary: "",
    title: input.title,
    topicId: input.topicId,
    workspaceId: "workspace-1"
  };
}

function createTaskSummary(
  input: Pick<IssueManagerTaskSummary, "issueId" | "taskId" | "title">
): IssueManagerTaskSummary {
  return {
    creatorUserId: "local",
    issueId: input.issueId,
    priority: "medium",
    status: "not_started",
    taskId: input.taskId,
    title: input.title,
    workspaceId: "workspace-1"
  };
}
