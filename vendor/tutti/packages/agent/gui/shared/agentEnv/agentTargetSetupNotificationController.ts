import type {
  AgentHostAgentTargetSetupAction,
  AgentHostAgentTargetSetupState
} from "../../host/agentHostApi.ts";

export interface AgentTargetSetupFailureNotification {
  actionId: string;
  actionKind: AgentHostAgentTargetSetupAction["kind"];
  errorCode?: string;
  errorMessage?: string;
  kind: "action_failed";
}

export interface AgentTargetSetupFailureNotificationController {
  observe(
    state: AgentHostAgentTargetSetupState
  ): AgentTargetSetupFailureNotification | null;
}

export function createAgentTargetSetupFailureNotificationController(
  initialState: AgentHostAgentTargetSetupState
): AgentTargetSetupFailureNotificationController {
  let previousAction = initialState.snapshot?.action ?? null;
  return {
    observe(state) {
      const action = state.snapshot?.action ?? null;
      const priorAction = previousAction;
      previousAction = action;
      if (
        !action ||
        !isFailed(action.status) ||
        priorAction?.actionId !== action.actionId ||
        !isRunning(priorAction.status)
      ) {
        return null;
      }
      return {
        actionId: action.actionId,
        actionKind: action.kind,
        errorCode: action.errorCode?.trim() || undefined,
        errorMessage: action.errorMessage?.trim() || undefined,
        kind: "action_failed"
      };
    }
  };
}

function isRunning(status: AgentHostAgentTargetSetupAction["status"]): boolean {
  return status === "queued" || status === "running";
}

function isFailed(status: AgentHostAgentTargetSetupAction["status"]): boolean {
  return status === "failed" || status === "interrupted";
}
