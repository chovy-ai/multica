import type { TranslateFn } from "../../../i18n/index";
import type { AgentGUIViewLabels } from "./AgentGUINodeView.types";

type AgentGUIProviderManagerLabels = Pick<
  AgentGUIViewLabels,
  | "manageAgents"
  | "manageAgentsTitle"
  | "manageAgentsDescription"
  | "manageAgentsAvailable"
  | "manageAgentsDisabled"
  | "manageAgentsNoAvailable"
  | "manageAgentsNoDisabled"
  | "manageAgentsKeepOneAvailable"
  | "manageAgentsRunningBlocked"
  | "removeAgentFromSidebar"
  | "addAgentToSidebar"
  | "dragAgentToReorder"
>;

export function agentGUIProviderManagerLabels(
  t: TranslateFn
): AgentGUIProviderManagerLabels {
  return {
    manageAgents: t("agentHost.agentGui.manageAgents"),
    manageAgentsTitle: t("agentHost.agentGui.manageAgentsTitle"),
    manageAgentsDescription: t("agentHost.agentGui.manageAgentsDescription"),
    manageAgentsAvailable: t("agentHost.agentGui.manageAgentsAvailable"),
    manageAgentsDisabled: t("agentHost.agentGui.manageAgentsDisabled"),
    manageAgentsNoAvailable: t("agentHost.agentGui.manageAgentsNoAvailable"),
    manageAgentsNoDisabled: t("agentHost.agentGui.manageAgentsNoDisabled"),
    manageAgentsKeepOneAvailable: t(
      "agentHost.agentGui.manageAgentsKeepOneAvailable"
    ),
    manageAgentsRunningBlocked: (agent) =>
      t("agentHost.agentGui.manageAgentsRunningBlocked", { agent }),
    removeAgentFromSidebar: (agent) =>
      t("agentHost.agentGui.removeAgentFromSidebar", { agent }),
    addAgentToSidebar: (agent) =>
      t("agentHost.agentGui.addAgentToSidebar", { agent }),
    dragAgentToReorder: (agent) =>
      t("agentHost.agentGui.dragAgentToReorder", { agent })
  };
}
