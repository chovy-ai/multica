import {
  type AgentActivityGoalControlAction,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useRef } from "react";
import { translate } from "../../../i18n/index";
import type { AgentComposerDraft } from "../model/agentGuiNodeTypes";
import {
  emptyAgentComposerDraft,
  snapshotAgentComposerDraft
} from "../model/agentComposerDraft";
import type { AgentGUIGoalControlPendingSettlement } from "./AgentGUIEngineSettlementController";

interface UseAgentGUIGoalControlActionsInput {
  activeConversationIdRef: RefObject<string | null>;
  draftByScopeKeyRef: RefObject<Record<string, AgentComposerDraft>>;
  goalControlSettlementsRef: RefObject<
    Record<string, AgentGUIGoalControlPendingSettlement>
  >;
  sessionEngine: AgentSessionEngine;
  setDetailError: Dispatch<SetStateAction<string | null>>;
}

export function useAgentGUIGoalControlActions(
  input: UseAgentGUIGoalControlActionsInput
) {
  const requestSequenceRef = useRef(0);
  const goalControl = useCallback(
    (
      action: AgentActivityGoalControlAction,
      objective?: string,
      submittedDraftScopeKey?: string
    ) => {
      const agentSessionId = input.activeConversationIdRef.current;
      if (!agentSessionId) return;
      const clientSubmitId = `goal-control:${Date.now()}:${++requestSequenceRef.current}`;
      const submittedDraftSnapshot = submittedDraftScopeKey
        ? {
            sourceScopeKey: submittedDraftScopeKey,
            content: snapshotAgentComposerDraft(
              input.draftByScopeKeyRef.current[submittedDraftScopeKey] ??
                emptyAgentComposerDraft()
            ),
            targetAgentSessionId: agentSessionId
          }
        : null;
      input.setDetailError(null);
      const admission = input.sessionEngine.controlGoal({
        action,
        agentSessionId,
        clientSubmitId,
        ...(objective !== undefined ? { objective } : {})
      });
      if (!admission.accepted) {
        input.setDetailError(translate("agentHost.agentGui.goalControlFailed"));
        return;
      }
      input.goalControlSettlementsRef.current[agentSessionId] = {
        action,
        clientSubmitId: admission.clientSubmitId,
        submittedDraftSnapshot
      };
    },
    [
      input.activeConversationIdRef,
      input.draftByScopeKeyRef,
      input.goalControlSettlementsRef,
      input.sessionEngine,
      input.setDetailError
    ]
  );
  return { goalControl };
}
