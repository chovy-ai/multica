import type {
  IssueManagerNodeState,
  IssueManagerPriority
} from "../../../../contracts/index.ts";
import type { IssueManagerFeature } from "../../../../core/index.ts";
import type {
  IssueManagerControllerSession,
  IssueManagerEditorMode,
  TaskDraft
} from "../../../../services/issueManagerControllerService.interface.ts";
import {
  applyIssueManagerTaskEditorModeToNodeState,
  applyIssueManagerTaskSelection,
  createIssueManagerTaskDraftFromNodeState,
  persistIssueManagerTaskDraftContent
} from "../../../../services/internal/controllerState.ts";
import { trackIssueManagerContentReferenceChanges } from "../../../../services/internal/controllerAnalytics.ts";
import {
  logIssueManagerDiagnostic,
  type IssueManagerDiagnostics
} from "../../../../internal/issueManagerDiagnostics.ts";

export function createIssueManagerTaskBindings(input: {
  controllerSession: IssueManagerControllerSession;
  diagnostics?: IssueManagerDiagnostics | null;
  feature: IssueManagerFeature;
  nodeState: IssueManagerNodeState;
  taskEditorMode: IssueManagerEditorMode;
}) {
  const { controllerSession, diagnostics, feature, nodeState, taskEditorMode } =
    input;

  return {
    selectTask(taskId: string | null) {
      controllerSession.updateNodeState((current) => {
        logIssueManagerDiagnostic(
          diagnostics,
          "task_selection.requested",
          {
            activeTopicId: current.activeTopicId ?? null,
            nextSelectedTaskId: taskId,
            previousSelectedIssueId: current.selectedIssueId,
            previousSelectedTaskId: current.selectedTaskId,
            taskEditorMode
          },
          { includeStack: true }
        );
        return applyIssueManagerTaskSelection(current, taskId);
      });
      controllerSession.setTaskEditorModeState("read");
    },
    setTaskContent(content: string) {
      controllerSession.setTaskDraftInternal((current) => {
        trackIssueManagerContentReferenceChanges({
          feature,
          nextContent: content,
          previousContent: current.content,
          targetType: "task"
        });
        return {
          ...current,
          content
        };
      });
      controllerSession.updateNodeState((current) =>
        persistIssueManagerTaskDraftContent(current, taskEditorMode, content)
      );
    },
    setTaskDraft(patch: Partial<TaskDraft>) {
      controllerSession.setTaskDraftInternal((current) => ({
        ...current,
        ...patch
      }));
    },
    setTaskEditorMode(mode: IssueManagerEditorMode) {
      logIssueManagerDiagnostic(
        diagnostics,
        "task_editor_mode.requested",
        {
          nextTaskEditorMode: mode,
          previousSelectedTaskId: nodeState.selectedTaskId,
          previousTaskEditorMode: taskEditorMode
        },
        { includeStack: true }
      );
      controllerSession.setTaskEditorModeState(mode);
      if (mode === "create") {
        controllerSession.setTaskDraftInternal(
          createIssueManagerTaskDraftFromNodeState(nodeState)
        );
      }
      controllerSession.updateNodeState((current) =>
        applyIssueManagerTaskEditorModeToNodeState(current, mode)
      );
    },
    setTaskListCollapsed(collapsed: boolean) {
      controllerSession.updateNodeState((current) => ({
        ...current,
        taskListCollapsed: collapsed
      }));
    },
    setTaskPriority(priority: IssueManagerPriority) {
      controllerSession.setTaskDraftInternal((current) => ({
        ...current,
        priority
      }));
    },
    setTaskTitle(title: string) {
      controllerSession.setTaskDraftInternal((current) => ({
        ...current,
        title
      }));
    }
  };
}
