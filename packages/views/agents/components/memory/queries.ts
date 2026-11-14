import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { AgentMemoryAdapter } from "./types";

// Agent CLI writes do not emit the server events used by the global cache.
export const memoryRefreshOptions = {
  staleTime: 0,
  refetchOnWindowFocus: true,
  refetchInterval: 5000,
};

export const memoryKeys = {
  all: (wsId: string, agentId: string) =>
    ["agent-memory", wsId, agentId] as const,
  tree: (wsId: string, agentId: string) =>
    [...memoryKeys.all(wsId, agentId), "tree"] as const,
  entry: (wsId: string, agentId: string, path: string) =>
    [...memoryKeys.all(wsId, agentId), "entry", path] as const,
  search: (wsId: string, agentId: string, query: string) =>
    [...memoryKeys.all(wsId, agentId), "search", query] as const,
};
export function memoryTreeOptions(
  wsId: string,
  agentId: string,
  adapter: AgentMemoryAdapter,
) {
  return queryOptions({
    ...memoryRefreshOptions,
    queryKey: memoryKeys.tree(wsId, agentId),
    queryFn: () => adapter.tree(agentId),
  });
}
export function useMemoryMutation<T, R>(
  wsId: string,
  agentId: string,
  mutationFn: (input: T) => Promise<R>,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: memoryKeys.all(wsId, agentId) }),
  });
}
