import { useCallback, useEffect, useRef } from "react";
import { useOptionalAgentHostApi } from "../../../agentActivityHost";
import type { UiLanguage } from "../../../contexts/settings/domain/agentSettings";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import type {
  AgentGUINodeViewProps,
  AgentGUIViewLabels
} from "./AgentGUINodeView.types";
import { useAgentGUIConversationCopyAction } from "./AgentGUIConversationActionsMenu";
import {
  AGENT_GUI_WORKBENCH_COMMAND_EVENT,
  normalizeAgentGuiWorkbenchCommand
} from "../../../workbench/commands";

type Conversation = AgentGUINodeViewModel["rail"]["conversations"][number];

function resolveSessionActionConversation(
  viewModel: AgentGUINodeViewModel,
  agentSessionId: string | null
): Conversation | null {
  const active = viewModel.rail.activeConversation;
  if (!agentSessionId) {
    return active;
  }
  if (active?.id === agentSessionId) {
    return active;
  }
  return (
    viewModel.rail.conversations.find(
      (conversation) => conversation.id === agentSessionId
    ) ?? null
  );
}

/**
 * Handles requests dispatched by the host chrome (workbench header) into the
 * AgentGUI node: creating a conversation and session actions (rename, copy
 * variants) targeting the conversation the header menu was rendered for.
 *
 * The header chrome cannot see the rail interaction lock or whether the
 * target conversation is loaded, so unlike the rail menus (which disable or
 * suppress actions up front) failures here surface as an error toast rather
 * than a silent drop.
 *
 * The rail query controller owns the interaction lock and lives inside the
 * rail subtree; it registers a probe through the returned callback so session
 * actions honor the same lock as the rail's own menus.
 */
export function useAgentGUIExternalRequests(input: {
  createConversationDisabled: boolean;
  labels: Pick<
    AgentGUIViewLabels,
    | "conversationCopyFile"
    | "conversationCopyImage"
    | "conversationCopyImagesOmitted"
    | "conversationCopyInProgress"
    | "conversationCopyMentionPrefix"
    | "conversationCopyPreviousMessages"
    | "copiedToClipboard"
    | "copyFailed"
    | "sessionActionUnavailable"
    | "untitledConversationTitle"
  >;
  requestCreateConversation: (options?: { source?: string }) => void;
  requestRenameConversation: (conversation: Conversation) => void;
  uiLanguage: UiLanguage;
  viewModel: AgentGUINodeViewModel;
  workbenchCommandBridge: NonNullable<
    AgentGUINodeViewProps["workbenchCommandBridge"]
  > | null;
}): {
  registerRailInteractionLockProbe: (probe: (() => boolean) | null) => void;
} {
  const {
    createConversationDisabled,
    labels,
    requestCreateConversation,
    requestRenameConversation,
    uiLanguage,
    viewModel,
    workbenchCommandBridge
  } = input;
  const agentHostApi = useOptionalAgentHostApi();
  const railInteractionLockProbeRef = useRef<(() => boolean) | null>(null);
  const registerRailInteractionLockProbe = useCallback(
    (probe: (() => boolean) | null) => {
      railInteractionLockProbeRef.current = probe;
    },
    []
  );
  const copyConversationValue = useAgentGUIConversationCopyAction(labels);
  const requestContextRef = useRef({
    agentHostApi,
    copyConversationValue,
    createConversationDisabled,
    labels,
    requestCreateConversation,
    requestRenameConversation,
    uiLanguage,
    viewModel,
    workbenchCommandBridge
  });
  requestContextRef.current = {
    agentHostApi,
    copyConversationValue,
    createConversationDisabled,
    labels,
    requestCreateConversation,
    requestRenameConversation,
    uiLanguage,
    viewModel,
    workbenchCommandBridge
  };
  useEffect(() => {
    if (!workbenchCommandBridge) {
      return;
    }
    const instanceId = workbenchCommandBridge.instanceId;
    const handleCommand = (event: Event): void => {
      const command = normalizeAgentGuiWorkbenchCommand(
        (event as CustomEvent<unknown>).detail
      );
      if (!command || command.instanceId !== instanceId) {
        return;
      }
      const current = requestContextRef.current;
      if (command.type === "conversation-rail-toggle") {
        current.workbenchCommandBridge?.onConversationRailToggle?.(
          command.conversationRailCollapsed
        );
        return;
      }
      if (command.type === "new-conversation") {
        if (!current.createConversationDisabled) {
          current.requestCreateConversation({ source: "external_request" });
        }
        return;
      }
      const conversation = resolveSessionActionConversation(
        current.viewModel,
        command.agentSessionId
      );
      const railInteractionLocked =
        railInteractionLockProbeRef.current?.() ?? false;
      if (!conversation || railInteractionLocked) {
        current.agentHostApi?.toast?.error(
          current.labels.sessionActionUnavailable
        );
      } else if (command.action === "rename") {
        current.requestRenameConversation(conversation);
      } else {
        current.copyConversationValue(command.action, {
          conversation,
          uiLanguage: current.uiLanguage,
          workspaceId: current.viewModel.shell.workspaceId
        });
      }
    };
    window.addEventListener(AGENT_GUI_WORKBENCH_COMMAND_EVENT, handleCommand);
    return () => {
      window.removeEventListener(
        AGENT_GUI_WORKBENCH_COMMAND_EVENT,
        handleCommand
      );
    };
  }, [workbenchCommandBridge?.instanceId]);
  return { registerRailInteractionLockProbe };
}
