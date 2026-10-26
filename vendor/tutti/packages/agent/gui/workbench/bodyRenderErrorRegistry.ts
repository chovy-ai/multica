import { useSyncExternalStore } from "react";

const listenersByNodeId = new Map<string, Set<() => void>>();
const errorNodeIds = new Set<string>();

export function setAgentGuiWorkbenchBodyRenderError(
  nodeId: string,
  hasError: boolean
): void {
  const hadError = errorNodeIds.has(nodeId);
  if (hadError === hasError) {
    return;
  }
  if (hasError) {
    errorNodeIds.add(nodeId);
  } else {
    errorNodeIds.delete(nodeId);
  }
  for (const listener of listenersByNodeId.get(nodeId) ?? []) {
    listener();
  }
}

function subscribeAgentGuiWorkbenchBodyRenderError(
  nodeId: string,
  listener: () => void
): () => void {
  let listeners = listenersByNodeId.get(nodeId);
  if (!listeners) {
    listeners = new Set();
    listenersByNodeId.set(nodeId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) {
      listenersByNodeId.delete(nodeId);
    }
  };
}

function getAgentGuiWorkbenchBodyRenderErrorSnapshot(nodeId: string): boolean {
  return errorNodeIds.has(nodeId);
}

export function useAgentGuiWorkbenchBodyRenderError(nodeId: string): boolean {
  return useSyncExternalStore(
    (listener) => subscribeAgentGuiWorkbenchBodyRenderError(nodeId, listener),
    () => getAgentGuiWorkbenchBodyRenderErrorSnapshot(nodeId)
  );
}
