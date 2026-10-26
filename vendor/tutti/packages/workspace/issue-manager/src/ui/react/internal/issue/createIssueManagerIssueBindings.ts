import type { IssueManagerNodeState } from "../../../../contracts/index.ts";
import type { IssueManagerFeature } from "../../../../core/index.ts";
import type {
  IssueDraft,
  IssueManagerControllerSession,
  IssueManagerEditorMode
} from "../../../../services/issueManagerControllerService.interface.ts";
import {
  applyIssueManagerIssueEditorModeToNodeState,
  createIssueManagerIssueDraftFromNodeState,
  persistIssueManagerIssueDraftContent
} from "../../../../services/internal/controllerState.ts";
import { trackIssueManagerContentReferenceChanges } from "../../../../services/internal/controllerAnalytics.ts";
import {
  logIssueManagerDiagnostic,
  type IssueManagerDiagnostics
} from "../../../../internal/issueManagerDiagnostics.ts";

export function createIssueManagerIssueBindings(input: {
  controllerSession: IssueManagerControllerSession;
  diagnostics?: IssueManagerDiagnostics | null;
  feature: IssueManagerFeature;
  issueEditorMode: IssueManagerEditorMode;
  nodeState: IssueManagerNodeState;
}) {
  const {
    controllerSession,
    diagnostics,
    feature,
    issueEditorMode,
    nodeState
  } = input;

  return {
    setIssueContent(content: string) {
      controllerSession.setIssueDraftInternal((current) => {
        trackIssueManagerContentReferenceChanges({
          feature,
          nextContent: content,
          previousContent: current.content,
          targetType: "issue"
        });
        return {
          ...current,
          content
        };
      });
      controllerSession.updateNodeState((current) =>
        persistIssueManagerIssueDraftContent(current, issueEditorMode, content)
      );
    },
    setIssueDraft(patch: Partial<IssueDraft>) {
      controllerSession.setIssueDraftInternal((current) => ({
        ...current,
        ...patch
      }));
    },
    setIssueEditorMode(mode: IssueManagerEditorMode) {
      logIssueManagerDiagnostic(
        diagnostics,
        "issue_editor_mode.requested",
        {
          nextIssueEditorMode: mode,
          previousIssueEditorMode: issueEditorMode,
          selectedIssueId: nodeState.selectedIssueId,
          selectedTaskId: nodeState.selectedTaskId
        },
        { includeStack: true }
      );
      controllerSession.setIssueEditorModeState(mode);
      if (mode === "create") {
        controllerSession.setIssueDraftInternal(
          createIssueManagerIssueDraftFromNodeState(nodeState)
        );
      }
      controllerSession.updateNodeState((current) =>
        applyIssueManagerIssueEditorModeToNodeState(current, mode)
      );
    },
    setIssueSearchQuery(query: string) {
      controllerSession.updateNodeState((current) => ({
        ...current,
        issueSearchQuery: query
      }));
    },
    setIssueStatusFilter(value: IssueManagerNodeState["issueStatusFilter"]) {
      controllerSession.updateNodeState((current) => ({
        ...current,
        issueStatusFilter: value
      }));
    },
    setIssueTitle(title: string) {
      controllerSession.setIssueDraftInternal((current) => ({
        ...current,
        title
      }));
    }
  };
}
