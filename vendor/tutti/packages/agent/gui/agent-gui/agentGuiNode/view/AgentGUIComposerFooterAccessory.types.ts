import type { ReactNode } from "react";
import type { AgentComposerProps } from "../AgentComposer";

export type AgentGUIComposerFooterAccessoryContext = Pick<
  AgentComposerProps,
  | "agentSessionId"
  | "isActive"
  | "isSendingTurn"
  | "isSubmittingPrompt"
  | "composerSettings"
  | "selectedAgentTarget"
>;

export type AgentGUIComposerFooterAccessoryRenderer = (
  context: AgentGUIComposerFooterAccessoryContext
) => ReactNode;
