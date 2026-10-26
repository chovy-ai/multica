import type { BuildWorkspaceAgentSessionDetailInput } from "../../workspaceAgentSessionDetailViewModel";
import { buildCanonicalWorkspaceAgentDetailView } from "../../workspaceAgentTimelineCanonical";
import type { AgentConversationVM } from "../contracts/agentConversationVM";
import {
  projectAgentConversationVM,
  type AgentConversationProjectionOptions
} from "./agentConversationProjection";

export function projectWorkspaceAgentTimelineToConversationVM(
  input: BuildWorkspaceAgentSessionDetailInput,
  options: AgentConversationProjectionOptions = {}
): AgentConversationVM {
  const detail = buildCanonicalWorkspaceAgentDetailView(input);
  const conversation = projectAgentConversationVM(detail, options);
  return conversation;
}

export { buildCanonicalWorkspaceAgentDetailView };
