import { useRef } from "react";
import { ActivityIndicator, ScrollView, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useAIConnection, useAISessionScope } from "@/data/ai-sessions/hooks";
import { aiKeys } from "@/data/ai-sessions/client";
import { remainingUsage, usageSchema } from "@/data/ai-sessions/schemas";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { useT } from "@/lib/i18n";

export default function AIUsage() {
  const { t } = useT("aiSessions");
  const { session, name } = useLocalSearchParams<{ session: string; name?: string }>();
  const { client, connected } = useAIConnection();
  const scope = useAISessionScope();
  const snapshot = useQuery({ queryKey: aiKeys.snapshot(scope, session), enabled: !!client && connected, queryFn: ({ signal }) => client!.snapshot(session, signal), staleTime: Infinity });
  const provider = snapshot.data?.conversation.provider;
  const force = useRef(false);
  const query = useQuery({ queryKey: [...aiKeys.scope(scope), "usage", session, provider], enabled: !!client && connected && !!provider,
    queryFn: ({ signal }) => { const refresh = force.current; force.current = false; return client!.request("GET", `/usage?${new URLSearchParams({ provider: provider!, conversation_id: session, force: String(refresh) })}`, usageSchema, undefined, signal); }, refetchInterval: connected ? 60_000 : false });
  const refresh = () => { force.current = true; void query.refetch(); };
  const data = query.data;
  const fmt = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : t("awaiting_refresh");
  const context = data?.context;
  const percent = context?.used_tokens != null && context.limit_tokens ? Math.max(0, Math.min(100, context.used_tokens / context.limit_tokens * 100)) : null;
  return <View className="flex-1 bg-background px-4 pt-4 gap-3">
    <View className="flex-row items-center"><Text className="flex-1 text-lg font-semibold">{t("usage")}</Text><IconButton name="refresh" accessibilityLabel={t("refresh_usage")} disabled={!connected || !provider || query.isFetching} onPress={refresh} /><Button variant="ghost" onPress={() => router.back()}><Text>{t("done")}</Text></Button></View>
    <Text className="text-sm text-muted-foreground">{provider === "claude" ? "Claude Code" : provider === "codex" ? "Codex" : ""} · {name || t("device_name")}</Text>
    <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 24 }}>
      <View className="flex-row"><Text className="flex-1 font-semibold">{t("account_remaining")}</Text><Text className="text-muted-foreground">{data?.account.plan}</Text></View>
      {query.isPending && connected && <ActivityIndicator />}
      {data?.account.windows.map((window) => { const remaining = remainingUsage(window.used_percent, window.resets_at); return <View key={window.id} className="gap-2">
        <View className="flex-row justify-between"><Text>{window.label === "5h" ? t("five_hour") : window.label === "7d" ? t("weekly") : window.label}</Text><Text>{remaining == null ? t("awaiting_refresh") : t("remaining", { count: Math.floor(remaining) })}</Text></View>
        {remaining != null && <Meter percent={remaining} />}
        {window.resets_at && <Text className="text-xs text-muted-foreground">{t("resets", { time: fmt(window.resets_at) })}</Text>}
      </View>; })}
      {(query.isError || !connected || data?.account.status === "error") && <Text accessibilityRole="alert" className="text-sm text-muted-foreground">{t(data?.account.windows.length ? "usage_stale" : "usage_error")}</Text>}
      {!query.isPending && !query.isError && connected && data?.account.status !== "error" && !data?.account.windows.length && <Text className="text-muted-foreground">{t("usage_unavailable")}</Text>}
      {(query.isError || !connected || data?.account.status === "error") && <Button variant="outline" disabled={!connected || !provider || query.isFetching} onPress={refresh}><Text>{t("retry")}</Text></Button>}
      <View className="pt-4 border-t border-border gap-2"><View className="flex-row justify-between"><Text>{t("context_usage")}</Text>{percent != null && <Text>{t("used_percent", { count: Math.round(percent) })}</Text>}</View>
        {context?.used_tokens != null ? <Text className="text-xs text-muted-foreground">{context.used_tokens.toLocaleString()}{context.limit_tokens ? ` / ${context.limit_tokens.toLocaleString()}` : ""} tokens</Text> : <Text className="text-muted-foreground">{t("context_unavailable")}</Text>}
      </View>
      {data?.account.updated_at && <Text className="text-xs text-muted-foreground">{t("updated_at", { time: fmt(data.account.updated_at) })}</Text>}
      <Text className="text-xs text-muted-foreground">{t("usage_shared")}</Text>
    </ScrollView>
  </View>;
}

function Meter({ percent }: { percent: number }) { return <View className="h-1 rounded-full bg-secondary overflow-hidden" accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: percent }}><View className="h-full bg-foreground" style={{ width: `${percent}%` }} /></View>; }
