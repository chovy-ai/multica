export const AGENT_GUI_WORKBENCH_COMMAND_EVENT =
  "tutti:agent-gui-workbench-command";

export type AgentGuiWorkbenchSessionAction =
  | "rename"
  | "copy-markdown"
  | "copy-reference";

const agentGuiWorkbenchSessionActions: readonly AgentGuiWorkbenchSessionAction[] =
  ["rename", "copy-markdown", "copy-reference"];

export function isAgentGuiWorkbenchSessionAction(
  value: unknown
): value is AgentGuiWorkbenchSessionAction {
  return agentGuiWorkbenchSessionActions.includes(
    value as AgentGuiWorkbenchSessionAction
  );
}

export type AgentGuiWorkbenchCommand =
  | {
      type: "new-conversation";
      instanceId: string;
    }
  | {
      type: "conversation-rail-toggle";
      conversationRailCollapsed: boolean;
      instanceId: string;
    }
  | {
      type: "session-action";
      action: AgentGuiWorkbenchSessionAction;
      agentSessionId: string | null;
      instanceId: string;
    };

export interface AgentGuiWorkbenchCommandBridge {
  instanceId: string;
  onConversationRailToggle?(conversationRailCollapsed: boolean): void;
}

export function normalizeAgentGuiWorkbenchCommand(
  value: unknown
): AgentGuiWorkbenchCommand | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const command = value as {
    action?: unknown;
    agentSessionId?: unknown;
    conversationRailCollapsed?: unknown;
    instanceId?: unknown;
    type?: unknown;
  };
  if (typeof command.instanceId !== "string" || !command.instanceId.trim()) {
    return null;
  }
  if (command.type === "new-conversation") {
    return {
      type: "new-conversation",
      instanceId: command.instanceId
    };
  }
  if (command.type === "conversation-rail-toggle") {
    return typeof command.conversationRailCollapsed === "boolean"
      ? {
          type: "conversation-rail-toggle",
          conversationRailCollapsed: command.conversationRailCollapsed,
          instanceId: command.instanceId
        }
      : null;
  }
  if (
    command.type !== "session-action" ||
    !isAgentGuiWorkbenchSessionAction(command.action)
  ) {
    return null;
  }
  return {
    type: "session-action",
    action: command.action,
    agentSessionId:
      typeof command.agentSessionId === "string" &&
      command.agentSessionId.trim()
        ? command.agentSessionId.trim()
        : null,
    instanceId: command.instanceId
  };
}

export function dispatchAgentGuiWorkbenchCommand(
  command: AgentGuiWorkbenchCommand
): void {
  window.dispatchEvent(
    new CustomEvent<AgentGuiWorkbenchCommand>(
      AGENT_GUI_WORKBENCH_COMMAND_EVENT,
      { detail: command }
    )
  );
}

export interface AgentGuiWorkbenchSessionMenuCopy {
  moreSessionActions: string;
  renameSession: string;
  copyAsMarkdown: string;
  copyAsReference: string;
}
