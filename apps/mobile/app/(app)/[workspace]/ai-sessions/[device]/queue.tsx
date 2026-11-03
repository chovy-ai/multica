import { useCallback, useState } from "react";
import { ActionSheetIOS, ActivityIndicator, Alert, ScrollView, View } from "react-native";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { localMessageDisplayContent } from "@multica/core/local-conversation/protocol";
import { useAIConnection, useAISessionScope } from "@/data/ai-sessions/hooks";
import { aiKeys } from "@/data/ai-sessions/client";
import { queueItemSchema, queueSchema, type AIQueue } from "@/data/ai-sessions/schemas";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { AIMessageContent } from "@/components/ai-sessions/reference-chips";
import { AISheet } from "@/components/ai-sessions/sheet";
import { SessionAttachment } from "@/components/ai-sessions/session-attachment";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

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
  const choose = (requestId: string) => ActionSheetIOS.showActionSheetWithOptions({ options: [t("cancel"), t("send_now_interrupt"), t("remove")], cancelButtonIndex: 0, destructiveButtonIndex: 2 }, (index) => {
    if (index === 1) update.mutate({ action: "send_now", requestId });
    if (index === 2) update.mutate({ action: "remove", requestId });
  });
  return <AISheet title={t("queue")}>
    <Text style={{ lineHeight: undefined }} className="text-sm text-muted-foreground">{t("queue_help")}</Text>
    <Button style={{ height: "auto", minHeight: 40 }} hitSlop={2} variant="outline" disabled={!connected || !query.data || update.isPending} onPress={() => update.mutate({ action: query.data?.paused ? "resume" : "pause" })}><Text style={{ lineHeight: undefined }}>{t(query.data?.paused ? "resume_queue" : "pause_queue")}</Text></Button>
    {!!query.data?.error && <Text style={{ lineHeight: undefined }} accessibilityRole="alert" className="text-sm text-destructive">{query.data.error}</Text>}
    {(query.isPending || update.isPending) && connected && <ActivityIndicator />}
    {(query.isError || !connected) && <Button style={{ height: "auto", minHeight: 40 }} hitSlop={2} variant="outline" disabled={!connected} onPress={() => void query.refetch()}><Text style={{ lineHeight: undefined }}>{t("retry")}</Text></Button>}
    <ScrollView className="flex-1" contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled">
      {!query.data?.items.length && query.isSuccess && <Text style={{ lineHeight: undefined }} className="py-6 text-muted-foreground">{t("queue_empty")}</Text>}
      {query.data?.items.map((item, index, items) => {
        const parsed = queueItemSchema.safeParse(item);
        return <View key={parsed.success ? parsed.data.requestId : index} className={cn("py-4 flex-row gap-3", index < items.length - 1 && "border-b border-border")}>
          <Text style={{ lineHeight: undefined }} className="text-muted-foreground">{index + 1}</Text>
          <View className="flex-1">
            {parsed.success ? <>
              <AIMessageContent content={localMessageDisplayContent({ role: "user", content: parsed.data.content, attachmentIds: parsed.data.attachmentIds })} />
              {parsed.data.attachmentIds.map((id) => <SessionAttachment key={id} id={id} />)}
            </> : <Text style={{ lineHeight: undefined }}>{t("operation_failed")}</Text>}
          </View>
          <IconButton name="ellipsis-horizontal" hitSlop={4} accessibilityLabel={t("more_actions")} disabled={!parsed.success || !connected || update.isPending} onPress={() => parsed.success && choose(parsed.data.requestId)} />
        </View>;
      })}
    </ScrollView>
  </AISheet>;
}
