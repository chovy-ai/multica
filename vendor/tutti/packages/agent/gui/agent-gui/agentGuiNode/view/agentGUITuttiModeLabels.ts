import type { TranslateFn } from "../../../i18n/index";
import type { AgentGUIViewLabels } from "../AgentGUINodeView";

type AgentGUITuttiModeLabels = Pick<
  AgentGUIViewLabels,
  | "tuttiBudgetEffectLabel"
  | "tuttiBudgetSpeedLabel"
  | "tuttiBudgetModelPreferenceBalance"
  | "tuttiBudgetModelPreferenceCost"
  | "tuttiBudgetModelPreferenceLabel"
  | "tuttiBudgetModelPreferencePowerful"
  | "tuttiBudgetPreviewBalance"
  | "tuttiBudgetPreviewCost"
  | "tuttiBudgetPreviewHint"
  | "tuttiBudgetPreviewPowerful"
  | "tuttiBudgetTitle"
  | "tuttiBudgetParallelismLabel"
  | "tuttiBudgetParallelismValue"
  | "tuttiModeDescription"
  | "tuttiModeLabel"
  | "tuttiModeRemove"
  | "tuttiModeUpdateFailed"
  | "tuttiModeUpdateUncertain"
>;

export function agentGUITuttiModeLabels(
  t: TranslateFn
): AgentGUITuttiModeLabels {
  return {
    tuttiModeLabel: t("agentHost.agentGui.tuttiModeLabel"),
    tuttiModeDescription: t("agentHost.agentGui.tuttiModeDescription"),
    tuttiModeRemove: t("agentHost.agentGui.tuttiModeRemove"),
    tuttiBudgetTitle: t("agentHost.agentGui.tuttiBudgetTitle"),
    tuttiBudgetEffectLabel: t("agentHost.agentGui.tuttiBudgetEffectLabel"),
    tuttiBudgetSpeedLabel: t("agentHost.agentGui.tuttiBudgetSpeedLabel"),
    tuttiBudgetPreviewHint: t("agentHost.agentGui.tuttiBudgetPreviewHint"),
    tuttiBudgetPreviewCost: t("agentHost.agentGui.tuttiBudgetPreviewCost"),
    tuttiBudgetPreviewBalance: t(
      "agentHost.agentGui.tuttiBudgetPreviewBalance"
    ),
    tuttiBudgetPreviewPowerful: t(
      "agentHost.agentGui.tuttiBudgetPreviewPowerful"
    ),
    tuttiBudgetModelPreferenceLabel: t(
      "agentHost.agentGui.tuttiBudgetModelPreferenceLabel"
    ),
    tuttiBudgetModelPreferenceCost: t(
      "agentHost.agentGui.tuttiBudgetModelPreferenceCost"
    ),
    tuttiBudgetModelPreferenceBalance: t(
      "agentHost.agentGui.tuttiBudgetModelPreferenceBalance"
    ),
    tuttiBudgetModelPreferencePowerful: t(
      "agentHost.agentGui.tuttiBudgetModelPreferencePowerful"
    ),
    tuttiBudgetParallelismLabel: t(
      "agentHost.agentGui.tuttiBudgetParallelismLabel"
    ),
    tuttiBudgetParallelismValue: (count) =>
      t("agentHost.agentGui.tuttiBudgetParallelismValue", { count }),
    tuttiModeUpdateFailed: t("agentHost.agentGui.tuttiModeUpdateFailed"),
    tuttiModeUpdateUncertain: t("agentHost.agentGui.tuttiModeUpdateUncertain")
  };
}
