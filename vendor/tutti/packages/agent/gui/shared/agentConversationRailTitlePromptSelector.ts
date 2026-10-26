import {
  selectSessionMessagesById,
  type AgentSessionEngineState
} from "@tutti-os/agent-activity-core";
import { resolveAgentGUIFirstUserMessageDisplayPrompt } from "./agentConversationTitleProjection.ts";

export type AgentGUIConversationRailTitlePromptsBySessionId = Readonly<
  Record<string, string>
>;

export function createAgentGUIConversationRailTitlePromptSelector(): (
  state: AgentSessionEngineState
) => AgentGUIConversationRailTitlePromptsBySessionId {
  let previous: AgentGUIConversationRailTitlePromptsBySessionId = {};

  return (state) => {
    const next: Record<string, string> = {};
    for (const [agentSessionId, messages] of Object.entries(
      selectSessionMessagesById(state)
    )) {
      const displayPrompt =
        resolveAgentGUIFirstUserMessageDisplayPrompt(messages);
      if (displayPrompt) {
        next[agentSessionId] = displayPrompt;
      }
    }
    if (agentGUIConversationRailTitlePromptsEqual(previous, next)) {
      return previous;
    }
    previous = next;
    return previous;
  };
}

function agentGUIConversationRailTitlePromptsEqual(
  left: AgentGUIConversationRailTitlePromptsBySessionId,
  right: AgentGUIConversationRailTitlePromptsBySessionId
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => left[key] === right[key])
  );
}
