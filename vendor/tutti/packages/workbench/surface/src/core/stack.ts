import type { WorkbenchNode } from "./types.ts";

export function normalizeWorkbenchStack(
  nodes: readonly WorkbenchNode[],
  stack: readonly string[]
): string[] {
  const nodeIDs = new Set(nodes.map((node) => node.id));
  const normalized = Array.from(new Set(stack)).filter((id) => nodeIDs.has(id));

  for (const node of nodes) {
    if (!normalized.includes(node.id)) {
      normalized.push(node.id);
    }
  }

  return normalized;
}

export function focusWorkbenchStack(
  stack: readonly string[],
  nodeID: string
): string[] {
  return [...stack.filter((id) => id !== nodeID), nodeID];
}

export function removeFromWorkbenchStack(
  stack: readonly string[],
  nodeID: string
): string[] {
  return stack.filter((id) => id !== nodeID);
}

export function orderWorkbenchNodesForRender<TData>(
  nodes: readonly WorkbenchNode<TData>[],
  stack: readonly string[]
): WorkbenchNode<TData>[] {
  const order = new Map(stack.map((id, index) => [id, index]));
  return [...nodes].sort(
    (left, right) =>
      (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right.id) ?? Number.MAX_SAFE_INTEGER)
  );
}
