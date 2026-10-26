import type { IssueManagerNodeState } from "../../contracts/index.ts";
import type {
  IssueManagerEditorMode,
  IssueManagerReferenceTarget
} from "./model.ts";
import type {
  IssueDraft,
  IssueManagerNotificationTone,
  TaskDraft
} from "./controllerTypes.ts";
import {
  applyIssueManagerIssueSaved,
  applyIssueManagerTaskSaved
} from "./controllerState.ts";

export interface IssueManagerControllerOutcome {
  issueDraft?: (current: IssueDraft) => IssueDraft;
  issueEditorMode?: IssueManagerEditorMode;
  nodeState?: (current: IssueManagerNodeState) => IssueManagerNodeState;
  notificationKey?: string;
  referenceTarget?: IssueManagerReferenceTarget | null;
  refreshAll?: boolean;
  refreshDetails?: boolean;
  taskDraft?: (current: TaskDraft) => TaskDraft;
  taskEditorMode?: IssueManagerEditorMode;
}

export interface ApplyIssueManagerControllerOutcomeInput {
  notify: (title: string, tone?: IssueManagerNotificationTone) => void;
  outcome: IssueManagerControllerOutcome;
  refreshAll: () => void;
  refreshDetails: () => void;
  setIssueDraftInternal: (updater: (current: IssueDraft) => IssueDraft) => void;
  setIssueEditorModeState: (mode: IssueManagerEditorMode) => void;
  setReferenceTarget: (target: IssueManagerReferenceTarget | null) => void;
  setTaskDraftInternal: (updater: (current: TaskDraft) => TaskDraft) => void;
  setTaskEditorModeState: (mode: IssueManagerEditorMode) => void;
  translate: (key: string) => string;
  updateNodeState: (
    updater: (current: IssueManagerNodeState) => IssueManagerNodeState
  ) => void;
}

export function applyIssueManagerControllerOutcome(
  input: ApplyIssueManagerControllerOutcomeInput
): void {
  if (input.outcome.notificationKey) {
    input.notify(input.translate(input.outcome.notificationKey));
  }
  if (input.outcome.issueDraft) {
    input.setIssueDraftInternal(input.outcome.issueDraft);
  }
  if (input.outcome.issueEditorMode) {
    input.setIssueEditorModeState(input.outcome.issueEditorMode);
  }
  if ("referenceTarget" in input.outcome) {
    input.setReferenceTarget(input.outcome.referenceTarget ?? null);
  }
  if (input.outcome.taskDraft) {
    input.setTaskDraftInternal(input.outcome.taskDraft);
  }
  if (input.outcome.taskEditorMode) {
    input.setTaskEditorModeState(input.outcome.taskEditorMode);
  }
  if (input.outcome.nodeState) {
    input.updateNodeState(input.outcome.nodeState);
  }
  if (input.outcome.refreshAll) {
    input.refreshAll();
  }
  if (input.outcome.refreshDetails) {
    input.refreshDetails();
  }
}

export function createIssueManagerRunTaskSuccessOutcome(input: {
  status: string;
}): IssueManagerControllerOutcome {
  return {
    notificationKey:
      input.status === "completed" || input.status === "opened"
        ? undefined
        : "messages.runFailed"
  };
}

export function createIssueManagerSaveIssueSuccessOutcome(
  issueId: string
): IssueManagerControllerOutcome {
  return {
    issueEditorMode: "read",
    nodeState: (current) => applyIssueManagerIssueSaved(current, issueId),
    refreshAll: true
  };
}

export function createIssueManagerSaveTaskSuccessOutcome(
  taskId: string
): IssueManagerControllerOutcome {
  return {
    nodeState: (current) => applyIssueManagerTaskSaved(current, taskId),
    refreshAll: true,
    taskEditorMode: "read"
  };
}
