import { getWorkbenchSnapRect } from "./geometry.ts";
import { orderWorkbenchNodesForRender } from "./stack.ts";
import type { WorkbenchFrame, WorkbenchNode, WorkbenchState } from "./types.ts";

export function selectVisibleWorkbenchNodes<TData>(
  state: WorkbenchState<TData>
): WorkbenchNode<TData>[] {
  return state.nodes.filter((node) => !node.isMinimized);
}

export function selectFocusedWorkbenchNode<TData>(
  state: WorkbenchState<TData>
): WorkbenchNode<TData> | null {
  const focusedID = state.nodeStack.at(-1);
  return state.nodes.find((node) => node.id === focusedID) ?? null;
}

export function selectFocusedVisibleWorkbenchNode<TData>(
  state: WorkbenchState<TData>
): WorkbenchNode<TData> | null {
  const nodeByID = new Map(state.nodes.map((node) => [node.id, node]));
  for (let index = state.nodeStack.length - 1; index >= 0; index -= 1) {
    const node = nodeByID.get(state.nodeStack[index] ?? "");
    if (node && !node.isMinimized) {
      return node;
    }
  }
  return state.nodes.find((node) => !node.isMinimized) ?? null;
}

export function selectFullscreenNodeToExitBeforeDockLaunch<TData>(
  state: WorkbenchState<TData>,
  targetNodeID?: string
): WorkbenchNode<TData> | null {
  const nodeByID = new Map(state.nodes.map((node) => [node.id, node]));
  const isVisibleFullscreenNode = (
    node: WorkbenchNode<TData> | undefined
  ): node is WorkbenchNode<TData> => {
    return (
      node !== undefined &&
      node.displayMode === "fullscreen" &&
      !node.isMinimized
    );
  };

  let target: WorkbenchNode<TData> | undefined;
  for (let index = state.nodeStack.length - 1; index >= 0; index -= 1) {
    const stackedNode = nodeByID.get(state.nodeStack[index] ?? "");
    if (isVisibleFullscreenNode(stackedNode)) {
      target = stackedNode;
      break;
    }
  }
  target ??= state.nodes.find(isVisibleFullscreenNode);

  if (!target || target.id === targetNodeID) {
    return null;
  }
  return target;
}

export function selectOrderedWorkbenchNodes<TData>(
  state: WorkbenchState<TData>
): WorkbenchNode<TData>[] {
  return orderWorkbenchNodesForRender(
    selectVisibleWorkbenchNodes(state),
    state.nodeStack
  );
}

export function selectWorkbenchNodeZIndex(
  state: WorkbenchState,
  nodeID: string
): number {
  const index = state.nodeStack.indexOf(nodeID);
  return index < 0 ? 1 : index + 1;
}

export function selectWorkbenchSnapPreviewRect(
  state: WorkbenchState
): WorkbenchFrame | null {
  return getWorkbenchSnapRect(
    state.activeSnapTarget,
    state.surfaceSize,
    state.layoutConstraints
  );
}
