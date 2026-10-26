import type { WorkbenchMinimizedDockSlot } from "./minimizedDockSlots.ts";

export type WorkbenchMinimizedDockRestoreIntent =
  | {
      anchorKey: string;
      kind: "node-slot";
      nodeId: string;
    }
  | {
      anchorKey: string;
      kind: "stack-popup-card";
      nodeId: string;
      stackAnchorKey: string;
    };

export type WorkbenchMinimizedDockRestoreSource =
  | {
      anchorKey: string;
      kind: "node-slot";
    }
  | {
      kind: "stack-popup-card";
      stackAnchorKey: string;
    };

export function resolveWorkbenchMinimizedDockRestoreIntent(input: {
  nodeId: string;
  slots: readonly WorkbenchMinimizedDockSlot[];
  source: WorkbenchMinimizedDockRestoreSource;
}): WorkbenchMinimizedDockRestoreIntent | null {
  const { source } = input;
  switch (source.kind) {
    case "node-slot": {
      const slot = input.slots.find(
        (slot) => slot.anchorKey === source.anchorKey
      );
      if (slot?.kind !== "node" || slot.node.id !== input.nodeId) {
        return null;
      }
      return {
        anchorKey: slot.anchorKey,
        kind: "node-slot",
        nodeId: input.nodeId
      };
    }

    case "stack-popup-card": {
      const slot = input.slots.find(
        (slot) => slot.anchorKey === source.stackAnchorKey
      );
      if (
        slot?.kind !== "stack" ||
        !slot.nodes.some((node) => node.id === input.nodeId)
      ) {
        return null;
      }
      return {
        anchorKey: slot.anchorKey,
        kind: "stack-popup-card",
        nodeId: input.nodeId,
        stackAnchorKey: slot.anchorKey
      };
    }
  }
}
