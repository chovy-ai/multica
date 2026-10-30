import { useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { localV2SummarySchema } from "@multica/core/local-conversation/v2";
import { useAIConnection, useAISessionScope } from "@/data/ai-sessions/hooks";
import { aiKeys } from "@/data/ai-sessions/client";
import { directoriesSchema } from "@/data/ai-sessions/schemas";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

export default function AIFolders() {
  const { t } = useT("aiSessions");
  const { session } = useLocalSearchParams<{ session?: string }>();
  const { client, connected } = useAIConnection();
  const scope = useAISessionScope();
  const qc = useQueryClient();
  const [path, setPath] = useState("");
  const query = useQuery({ queryKey: [...aiKeys.scope(scope), "directories", path], enabled: !!client && connected,
    queryFn: ({ signal }) => client!.request("GET", `/directories?${new URLSearchParams({ path })}`, directoriesSchema, undefined, signal) });
  const apply = useMutation({ mutationFn: async () => {
    if (!query.data || !client || !connected) throw new Error("device_unreachable");
    if (session) return client.command(session, { type: "set_directory", cwd: query.data.path }, localV2SummarySchema);
    return client.request("POST", "/folder-projects", z.object({ id: z.string(), title: z.string(), path: z.string() }), { path: query.data.path });
  }, onSuccess: () => { void qc.invalidateQueries({ queryKey: aiKeys.scope(scope) }); router.back(); }, onError: () => Alert.alert(t("error_title"), t("operation_failed")) });
  return <View className="flex-1 bg-background p-4 gap-3">
    <Text className="text-base font-semibold">{t("choose_folder")}</Text>
    <Text className="text-xs text-muted-foreground" selectable>{query.data?.path}</Text>
    {!!query.data?.parent && <Button variant="ghost" onPress={() => setPath(query.data!.parent)}><Text>↑ {t("parent")}</Text></Button>}
    {query.isPending && <ActivityIndicator />}
    {query.isError && <Button variant="outline" onPress={() => void query.refetch()}><Text>{t("retry")}</Text></Button>}
    <FlatList data={query.data?.entries} keyExtractor={(entry) => entry.path} renderItem={({ item }) => <Pressable accessibilityRole="button" className="py-4 border-b border-border active:bg-secondary" onPress={() => setPath(item.path)}><Text>{item.name} ›</Text></Pressable>} />
    <Button disabled={!connected || !query.data || apply.isPending} onPress={() => apply.mutate()}><Text>{t("use_folder")}</Text></Button>
    <Button variant="ghost" onPress={() => router.back()}><Text>{t("cancel")}</Text></Button>
  </View>;
}
