import type { WorkbenchNode } from "../core/types.ts";
import type {
  WorkbenchHostNodeData,
  WorkbenchHostNodeDefinition
} from "./types.ts";

export const workbenchMinimizedDockVisibleSlotLimit = 5;
export const workbenchMinimizedDockStackedVisibleNodeCount = 4;
export const workbenchMinimizedDockStackAnchorKey = "minimized-stack";

export type WorkbenchMinimizedDockNode = WorkbenchNode<WorkbenchHostNodeData>;

export type WorkbenchMinimizedDockSlot =
  | {
      anchorKey: string;
      kind: "node";
      node: WorkbenchMinimizedDockNode;
    }
  | {
      anchorKey: string;
      kind: "stack";
      nodes: WorkbenchMinimizedDockNode[];
    };

export function resolveWorkbenchMinimizedDockNodeAnchorKey(
  nodeId: string
): string {
  return `minimized:${nodeId}`;
}

export function resolveWorkbenchMinimizedDockSlots(input: {
  nodeDefinitions: ReadonlyMap<string, WorkbenchHostNodeDefinition>;
  nodes: readonly WorkbenchMinimizedDockNode[];
}): WorkbenchMinimizedDockSlot[] {
  const minimizedNodes = orderWorkbenchMinimizedDockNodes(input);
  if (minimizedNodes.length === 0) {
    return [];
  }
  if (minimizedNodes.length <= workbenchMinimizedDockVisibleSlotLimit) {
    return minimizedNodes.map((node) => ({
      anchorKey: resolveWorkbenchMinimizedDockNodeAnchorKey(node.id),
      kind: "node",
      node
    }));
  }

  return [
    ...minimizedNodes
      .slice(0, workbenchMinimizedDockStackedVisibleNodeCount)
      .map((node) => ({
        anchorKey: resolveWorkbenchMinimizedDockNodeAnchorKey(node.id),
        kind: "node" as const,
        node
      })),
    {
      anchorKey: workbenchMinimizedDockStackAnchorKey,
      kind: "stack",
      nodes: minimizedNodes.slice(workbenchMinimizedDockStackedVisibleNodeCount)
    }
  ];
}

export function resolveWorkbenchMinimizedDockAnchorKeyForNode(input: {
  nodeId: string;
  slots: readonly WorkbenchMinimizedDockSlot[];
}): string | null {
  for (const slot of input.slots) {
    if (slot.kind === "node" && slot.node.id === input.nodeId) {
      return slot.anchorKey;
    }
    if (
      slot.kind === "stack" &&
      slot.nodes.some((node) => node.id === input.nodeId)
    ) {
      return slot.anchorKey;
    }
  }
  return null;
}

export function isWorkbenchMinimizedDockEligibleNode(input: {
  node: WorkbenchMinimizedDockNode;
  nodeDefinitions: ReadonlyMap<string, WorkbenchHostNodeDefinition>;
}): boolean {
  const definition = input.nodeDefinitions.get(input.node.data.typeId);
  return definition?.window?.minimizedDock !== undefined;
}

function orderWorkbenchMinimizedDockNodes(input: {
  nodeDefinitions: ReadonlyMap<string, WorkbenchHostNodeDefinition>;
  nodes: readonly WorkbenchMinimizedDockNode[];
}): WorkbenchMinimizedDockNode[] {
  return input.nodes
    .map((node, index) => ({ index, node }))
    .filter(
      ({ node }) =>
        node.isMinimized &&
        isWorkbenchMinimizedDockEligibleNode({
          node,
          nodeDefinitions: input.nodeDefinitions
        })
    )
    .sort((left, right) => {
      const leftTime = left.node.minimizedAtUnixMs ?? 0;
      const rightTime = right.node.minimizedAtUnixMs ?? 0;
      if (leftTime !== rightTime) {
        return rightTime - leftTime;
      }
      return right.index - left.index;
    })
    .map(({ node }) => node);
}
