import { useCallback, useState } from "react";
import { ActionSheetIOS, ActivityIndicator, Alert, FlatList, Pressable, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAIConnection, useAISessionScope } from "@/data/ai-sessions/hooks";
import { aiKeys } from "@/data/ai-sessions/client";
import { queueItemSchema, queueSchema, type AIQueue } from "@/data/ai-sessions/schemas";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

export default function AIQueueScreen() {
  const { t } = useT("aiSessions");
  const { session } = useLocalSearchParams<{ session: string }>();
  const { client, connected } = useAIConnection();
  const scope = useAISessionScope();
  const qc = useQueryClient();
  const [active, setActive] = useState(false);
  useFocusEffect(useCallback(() => { setActive(true); return () => setActive(false); }, []));
  const key = [...aiKeys.scope(scope), "queue", session];
  const query = useQuery({ queryKey: key, enabled: !!client && connected && active,
    queryFn: async ({ signal }) => { const next = await client!.request("GET", `/sessions/${encodeURIComponent(session)}/queue`, queueSchema, undefined, signal); const current = qc.getQueryData<AIQueue>(key); return current && current.revision > next.revision ? current : next; }, refetchInterval: active && connected ? 2000 : false });
  const update = useMutation({ mutationFn: ({ action, requestId }: { action: "pause" | "resume" | "remove" | "send_now"; requestId?: string }) => client!.command(session, { type: "queue_update", action, request_id: requestId }, queueSchema),
    onSuccess: (queue) => { qc.setQueryData(key, queue); void qc.invalidateQueries({ queryKey: aiKeys.snapshot(scope, session) }); },
    onError: () => { Alert.alert(t("error_title"), t("operation_failed")); void query.refetch(); },
  });
  const choose = (requestId: string) => ActionSheetIOS.showActionSheetWithOptions({ options: [t("cancel"), t("send_now"), t("remove")], cancelButtonIndex: 0, destructiveButtonIndex: 2 }, (index) => {
    if (index === 1) update.mutate({ action: "send_now", requestId });
    if (index === 2) update.mutate({ action: "remove", requestId });
  });
  return <View className="flex-1 bg-background px-4 pt-4 gap-3">
    <View className="flex-row items-center"><Text className="text-lg font-semibold flex-1">{t("queue")}</Text><Button variant="ghost" onPress={() => router.back()}><Text>{t("done")}</Text></Button></View>
    <Text className="text-sm text-muted-foreground">{t("queue_help")}</Text>
    <Button variant="outline" disabled={!connected || !query.data || update.isPending} onPress={() => update.mutate({ action: query.data?.paused ? "resume" : "pause" })}><Text>{t(query.data?.paused ? "resume_queue" : "pause_queue")}</Text></Button>
    {!!query.data?.error && <Text accessibilityRole="alert" className="text-sm text-destructive">{query.data.error}</Text>}
    {(query.isPending || update.isPending) && connected && <ActivityIndicator />}
    {(query.isError || !connected) && <Button variant="outline" disabled={!connected} onPress={() => void query.refetch()}><Text>{t("retry")}</Text></Button>}
    <FlatList data={query.data?.items ?? []} keyExtractor={(item, index) => queueItemSchema.safeParse(item).data?.requestId ?? String(index)} ListEmptyComponent={!query.isPending ? <Text className="py-6 text-muted-foreground">{t("queue_empty")}</Text> : null}
      renderItem={({ item, index }) => { const parsed = queueItemSchema.safeParse(item); return <Pressable disabled={!parsed.success || !connected || update.isPending} accessibilityRole="button" onPress={() => parsed.success && choose(parsed.data.requestId)} className="py-4 border-b border-border flex-row gap-3"><Text className="text-muted-foreground">{index + 1}</Text><Text className="flex-1" numberOfLines={3}>{parsed.success ? parsed.data.content : t("operation_failed")}</Text><Text>⋯</Text></Pressable>; }} />
  </View>;
}
