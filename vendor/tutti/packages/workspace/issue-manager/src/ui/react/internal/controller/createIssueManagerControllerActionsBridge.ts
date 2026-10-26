import type { IssueManagerFeature } from "../../../../core/index.ts";
import type { IssueManagerI18nRuntime } from "../../../../i18n/issueManagerI18n.ts";
import type { IssueManagerControllerSession } from "../../../../services/issueManagerControllerService.interface.ts";
import { createIssueManagerControllerActions } from "../../../../services/internal/controllerActions.ts";
import type {
  IssueDraft,
  IssueManagerNotificationState,
  TaskDraft
} from "../../../../services/controllerTypes.ts";
import type {
  IssueManagerEditorMode,
  IssueManagerReferenceTarget
} from "../../../../services/controllerModel.ts";
import type {
  IssueManagerIssueDetail,
  IssueManagerNodeState,
  IssueManagerTaskDetail
} from "../../../../contracts/index.ts";
import {
  logIssueManagerDiagnostic,
  type IssueManagerDiagnostics
} from "../../../../internal/issueManagerDiagnostics.ts";

export function createIssueManagerControllerActionsBridge(input: {
  controllerSession: IssueManagerControllerSession;
  copy: IssueManagerI18nRuntime;
  diagnostics?: IssueManagerDiagnostics | null;
  feature: IssueManagerFeature;
  issueDetail: {
    value: IssueManagerIssueDetail | null;
  };
  issueDraft: IssueDraft;
  issueEditorMode: IssueManagerEditorMode;
  nodeState: IssueManagerNodeState;
  referenceTarget: IssueManagerReferenceTarget | null;
  taskDetail: {
    value: IssueManagerTaskDetail | null;
  };
  taskDraft: TaskDraft;
  taskEditorMode: IssueManagerEditorMode;
  workspaceId: string;
}) {
  const {
    controllerSession,
    copy,
    diagnostics,
    feature,
    issueDetail,
    issueDraft,
    issueEditorMode,
    nodeState,
    referenceTarget,
    taskDetail,
    taskDraft,
    taskEditorMode,
    workspaceId
  } = input;

  return createIssueManagerControllerActions({
    copy,
    feature,
    issueDetail,
    issueDraft,
    issueEditorMode,
    nodeState,
    referenceTarget,
    refreshAll: () => controllerSession.refreshAll(),
    refreshDetails: () => controllerSession.refreshDetails(),
    setNotification: (update) =>
      controllerSession.setNotification((current) =>
        createIssueManagerControllerNotificationState(current, update)
      ),
    setIsRunningTask: (update) => controllerSession.setIsRunningTask(update),
    setIssueDraftInternal: (update) =>
      controllerSession.setIssueDraftInternal(update),
    setIssueEditorModeState: (update) => {
      const nextMode =
        typeof update === "function" ? update(issueEditorMode) : update;
      logIssueManagerDiagnostic(
        diagnostics,
        "issue_editor_mode.action_requested",
        {
          nextIssueEditorMode: nextMode,
          previousIssueEditorMode: issueEditorMode,
          selectedIssueId: nodeState.selectedIssueId,
          selectedTaskId: nodeState.selectedTaskId
        },
        { includeStack: true }
      );
      controllerSession.setIssueEditorModeState(nextMode);
    },
    setReferenceTarget: (update) =>
      controllerSession.setReferenceTarget(update),
    setTaskDraftInternal: (update) =>
      controllerSession.setTaskDraftInternal(update),
    setTaskEditorModeState: (update) => {
      const nextMode =
        typeof update === "function" ? update(taskEditorMode) : update;
      logIssueManagerDiagnostic(
        diagnostics,
        "task_editor_mode.action_requested",
        {
          nextTaskEditorMode: nextMode,
          previousSelectedTaskId: nodeState.selectedTaskId,
          previousTaskEditorMode: taskEditorMode
        },
        { includeStack: true }
      );
      controllerSession.setTaskEditorModeState(nextMode);
    },
    taskDetail,
    taskDraft,
    taskEditorMode,
    updateNodeState: (updater) => controllerSession.updateNodeState(updater),
    workspaceId
  });
}

function createIssueManagerControllerNotificationState(
  current: IssueManagerNotificationState | null,
  input: {
    title: string;
    tone?: IssueManagerNotificationState["tone"];
  }
): IssueManagerNotificationState {
  return {
    id: (current?.id ?? 0) + 1,
    title: input.title,
    tone: input.tone ?? "default"
  };
}
