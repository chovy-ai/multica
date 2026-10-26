import { useMemo, useRef } from "react";
import type { AgentConversationVM } from "../contracts/agentConversationVM";
import type { WorkspaceAgentSessionDetailViewModel } from "../../workspaceAgentSessionDetailViewModel";
import {
  projectAgentConversationVM,
  reconcileProjectedAgentConversationVM
} from "./agentConversationProjection";

export function useProjectedAgentConversation({
  conversation,
  detail,
  avoidGroupingEdits = false
}: {
  conversation?: AgentConversationVM | null;
  detail?: WorkspaceAgentSessionDetailViewModel | null;
  avoidGroupingEdits?: boolean;
}): AgentConversationVM | null {
  const previousConversationRef = useRef<AgentConversationVM | null>(null);

  return useMemo(() => {
    if (!conversation && !detail) {
      previousConversationRef.current = null;
      return null;
    }

    const nextConversation =
      conversation ??
      projectAgentConversationVM(
        detail as WorkspaceAgentSessionDetailViewModel,
        {
          avoidGroupingEdits
        }
      );
    const reconciledConversation = reconcileProjectedAgentConversationVM(
      previousConversationRef.current,
      nextConversation
    );
    previousConversationRef.current = reconciledConversation;
    return reconciledConversation;
  }, [avoidGroupingEdits, conversation, detail]);
}
