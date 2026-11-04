import { useQuery } from "@tanstack/react-query";
import { aiKeys } from "./client";
import { useAIConnection, useAISessionScope } from "./hooks";
import { modelsSchema } from "./schemas";

export function useAISessionSettings(session: string) {
  const scope = useAISessionScope();
  const { client, connected } = useAIConnection();
  const snapshot = useQuery({ queryKey: aiKeys.snapshot(scope, session), enabled: !!client && connected, staleTime: Infinity, queryFn: ({ signal }) => client!.snapshot(session, signal) });
  const provider = snapshot.data?.conversation.provider;
  const models = useQuery({ queryKey: [...aiKeys.scope(scope), "models", provider], enabled: !!client && connected && !!provider,
    queryFn: ({ signal }) => client!.request("GET", `/models?${new URLSearchParams({ provider: provider! })}`, modelsSchema, undefined, signal) });
  const settings = snapshot.data?.settings;
  const selected = models.data?.models.find((model) => model.id === settings?.model);
  const levels = selected?.thinking?.supported_levels ?? [];
  const running = snapshot.data?.turns.some((turn) => turn.status === "running") ?? false;
  return { scope, client, connected, snapshot, models, provider, settings, selected, levels, running, disabled: !connected || !settings || running };
}
