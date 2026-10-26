import type { AgentGUIAgentTarget } from "../../../types";
import type { AgentGUIConversationSummary } from "./agentGuiConversationTypes";

export const AGENT_GUI_PROVIDER_RAIL_PREFERENCES_STORAGE_KEY =
  "agent-gui:provider-rail-preferences";

export const AGENT_GUI_PROVIDER_RAIL_PREFERENCES_EVENT =
  "agent-gui:provider-rail-preferences-changed";

export interface AgentGUIProviderRailPreferences {
  hiddenTargetIds: readonly string[];
  order: readonly string[];
}

export interface AgentGUIProviderManagerDropPlacement {
  overTargetId: string;
  position: "before" | "after";
}

export interface AgentGUIManagedHomeTargetProjection {
  agentTargets: readonly AgentGUIAgentTarget[];
  selectedAgentTarget: AgentGUIAgentTarget | null;
}

const emptyAgentGUIProviderRailPreferences: AgentGUIProviderRailPreferences = {
  hiddenTargetIds: [],
  order: []
};

export function agentGUIProviderRailOrderStorageKey(
  ..._legacyWorkspaceId: readonly unknown[]
): string {
  return AGENT_GUI_PROVIDER_RAIL_PREFERENCES_STORAGE_KEY;
}

export function parseAgentGUIProviderRailPreferences(
  rawValue: string | null | undefined
): AgentGUIProviderRailPreferences {
  if (!rawValue) {
    return emptyAgentGUIProviderRailPreferences;
  }
  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return emptyAgentGUIProviderRailPreferences;
    }
    const candidate = parsed as {
      hiddenTargetIds?: unknown;
      order?: unknown;
      version?: unknown;
    };
    if (candidate.version !== 1) {
      return emptyAgentGUIProviderRailPreferences;
    }
    return {
      hiddenTargetIds: Array.isArray(candidate.hiddenTargetIds)
        ? sanitizeAgentGUIProviderRailOrder(candidate.hiddenTargetIds)
        : [],
      order: Array.isArray(candidate.order)
        ? sanitizeAgentGUIProviderRailOrder(candidate.order)
        : []
    };
  } catch {
    return emptyAgentGUIProviderRailPreferences;
  }
}

export function serializeAgentGUIProviderRailPreferences(
  preferences: AgentGUIProviderRailPreferences
): string {
  return JSON.stringify({
    version: 1,
    order: sanitizeAgentGUIProviderRailOrder(preferences.order),
    hiddenTargetIds: sanitizeAgentGUIProviderRailOrder(
      preferences.hiddenTargetIds
    )
  });
}

export function parseAgentGUIProviderRailOrder(
  rawValue: string | null | undefined
): readonly string[] {
  if (!rawValue) {
    return [];
  }
  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return sanitizeAgentGUIProviderRailOrder(parsed);
  } catch {
    return [];
  }
}

export function serializeAgentGUIProviderRailOrder(
  order: readonly string[]
): string {
  return JSON.stringify(sanitizeAgentGUIProviderRailOrder(order));
}

export function sanitizeAgentGUIProviderRailOrder(
  order: readonly unknown[]
): readonly string[] {
  const seen = new Set<string>();
  const sanitized: string[] = [];
  for (const value of order) {
    if (typeof value !== "string") {
      continue;
    }
    const targetId = value.trim();
    if (!targetId || seen.has(targetId)) {
      continue;
    }
    seen.add(targetId);
    sanitized.push(targetId);
  }
  return sanitized;
}

export function applyAgentGUIProviderRailOrder<
  T extends Pick<AgentGUIAgentTarget, "targetId">
>(targets: readonly T[], order: readonly string[]): readonly T[] {
  const knownOrder = sanitizeAgentGUIProviderRailOrder(order);
  if (knownOrder.length === 0 || targets.length <= 1) {
    return targets;
  }
  const indexByTargetId = new Map<string, number>();
  knownOrder.forEach((targetId, index) => {
    indexByTargetId.set(targetId, index);
  });
  return [...targets].sort((left, right) => {
    const leftIndex = indexByTargetId.get(left.targetId);
    const rightIndex = indexByTargetId.get(right.targetId);
    if (leftIndex === undefined && rightIndex === undefined) {
      return 0;
    }
    if (leftIndex === undefined) {
      return 1;
    }
    if (rightIndex === undefined) {
      return -1;
    }
    return leftIndex - rightIndex;
  });
}

export function applyAgentGUIProviderRailVisibility<
  T extends Pick<AgentGUIAgentTarget, "targetId">
>(targets: readonly T[], hiddenTargetIds: readonly string[]): readonly T[] {
  const hidden = new Set(
    normalizeAgentGUIProviderRailHiddenTargetIds(
      targets.map((target) => target.targetId),
      hiddenTargetIds
    )
  );
  if (hidden.size === 0) {
    return targets;
  }
  return targets.filter((target) => !hidden.has(target.targetId));
}

export function agentGUIRunningTargetIds(input: {
  activeConversation?: AgentGUIConversationSummary | null;
  agentTargets: readonly AgentGUIAgentTarget[];
  conversations: readonly AgentGUIConversationSummary[];
}): readonly string[] {
  const runningTargetIds = new Set<string>();
  const seenConversationIds = new Set<string>();
  for (const conversation of [
    ...input.conversations,
    ...(input.activeConversation ? [input.activeConversation] : [])
  ]) {
    if (
      seenConversationIds.has(conversation.id) ||
      (conversation.status !== "working" && conversation.status !== "waiting")
    ) {
      continue;
    }
    seenConversationIds.add(conversation.id);
    const agentTargetId = conversation.agentTargetId?.trim() ?? "";
    for (const target of input.agentTargets) {
      const targetMatches = agentTargetId
        ? target.targetId === agentTargetId ||
          target.agentTargetId === agentTargetId
        : target.provider === conversation.provider;
      if (targetMatches) {
        runningTargetIds.add(target.targetId);
      }
    }
  }
  return [...runningTargetIds];
}

export function projectAgentGUIManagedHomeTargets(input: {
  agentTargets: readonly AgentGUIAgentTarget[];
  preferences: AgentGUIProviderRailPreferences;
  selectedAgentTarget: AgentGUIAgentTarget | null;
}): AgentGUIManagedHomeTargetProjection {
  const agentTargets = applyAgentGUIProviderRailVisibility(
    applyAgentGUIProviderRailOrder(input.agentTargets, input.preferences.order),
    input.preferences.hiddenTargetIds
  );
  const selectedAgentTarget = input.selectedAgentTarget;
  if (!selectedAgentTarget) {
    return { agentTargets, selectedAgentTarget: null };
  }
  const selectedTargetIds = new Set(
    [selectedAgentTarget.targetId, selectedAgentTarget.agentTargetId]
      .map((targetId) => targetId?.trim() ?? "")
      .filter(Boolean)
  );
  if (
    !input.preferences.hiddenTargetIds.some((targetId) =>
      selectedTargetIds.has(targetId)
    )
  ) {
    return { agentTargets, selectedAgentTarget };
  }
  return {
    agentTargets,
    selectedAgentTarget:
      agentTargets.find(
        (target) =>
          selectedTargetIds.has(target.targetId) ||
          (target.agentTargetId
            ? selectedTargetIds.has(target.agentTargetId)
            : false)
      ) ??
      agentTargets.find((target) => target.disabled !== true) ??
      agentTargets[0] ??
      selectedAgentTarget
  };
}

export function normalizeAgentGUIProviderRailHiddenTargetIds(
  currentTargetIds: readonly string[],
  hiddenTargetIds: readonly string[]
): readonly string[] {
  const current = sanitizeAgentGUIProviderRailOrder(currentTargetIds);
  const hidden = sanitizeAgentGUIProviderRailOrder(hiddenTargetIds);
  if (
    current.length === 0 ||
    current.some((targetId) => !hidden.includes(targetId))
  ) {
    return hiddenTargetIds;
  }
  return hidden.filter((targetId) => targetId !== current[0]);
}

export function reorderAgentGUIProviderRailOrder(input: {
  currentTargetIds: readonly string[];
  draggedTargetId: string;
  dropPosition: "before" | "after";
  overTargetId: string;
}): readonly string[] {
  const currentTargetIds = sanitizeAgentGUIProviderRailOrder(
    input.currentTargetIds
  );
  const draggedTargetId = input.draggedTargetId.trim();
  const overTargetId = input.overTargetId.trim();
  if (
    !draggedTargetId ||
    !overTargetId ||
    draggedTargetId === overTargetId ||
    !currentTargetIds.includes(draggedTargetId) ||
    !currentTargetIds.includes(overTargetId)
  ) {
    return currentTargetIds;
  }

  const withoutDragged = currentTargetIds.filter(
    (targetId) => targetId !== draggedTargetId
  );
  const overIndex = withoutDragged.indexOf(overTargetId);
  if (overIndex < 0) {
    return currentTargetIds;
  }
  const insertIndex =
    input.dropPosition === "after" ? overIndex + 1 : overIndex;
  return [
    ...withoutDragged.slice(0, insertIndex),
    draggedTargetId,
    ...withoutDragged.slice(insertIndex)
  ];
}

export function changeAgentGUIProviderManagerVisibility(input: {
  currentTargetIds: readonly string[];
  placement?: AgentGUIProviderManagerDropPlacement;
  preferences: AgentGUIProviderRailPreferences;
  runningTargetIds?: readonly string[];
  targetId: string;
  visible: boolean;
}): AgentGUIProviderRailPreferences {
  const currentTargetIds = sanitizeAgentGUIProviderRailOrder(
    input.currentTargetIds
  );
  const targetId = input.targetId.trim();
  if (!targetId || !currentTargetIds.includes(targetId)) {
    return input.preferences;
  }
  if (
    !input.visible &&
    sanitizeAgentGUIProviderRailOrder(input.runningTargetIds ?? []).includes(
      targetId
    )
  ) {
    return input.preferences;
  }
  const hiddenTargetIds = new Set(
    normalizeAgentGUIProviderRailHiddenTargetIds(
      currentTargetIds,
      input.preferences.hiddenTargetIds
    )
  );
  const availableTargetCount = currentTargetIds.filter(
    (candidateId) => !hiddenTargetIds.has(candidateId)
  ).length;
  if (
    !input.visible &&
    !hiddenTargetIds.has(targetId) &&
    availableTargetCount <= 1
  ) {
    return input.preferences;
  }

  let order = input.preferences.order;
  const fallbackTargetId = currentTargetIds
    .filter(
      (candidateId) =>
        candidateId !== targetId &&
        (input.visible
          ? !hiddenTargetIds.has(candidateId)
          : hiddenTargetIds.has(candidateId))
    )
    .at(-1);
  const placement =
    input.placement ??
    (fallbackTargetId
      ? { overTargetId: fallbackTargetId, position: "after" as const }
      : null);
  if (placement) {
    order = reorderAgentGUIProviderRailOrder({
      currentTargetIds,
      draggedTargetId: targetId,
      dropPosition: placement.position,
      overTargetId: placement.overTargetId
    });
  }

  if (input.visible) {
    hiddenTargetIds.delete(targetId);
  } else {
    hiddenTargetIds.add(targetId);
  }
  return {
    ...input.preferences,
    hiddenTargetIds: [...hiddenTargetIds],
    order
  };
}
