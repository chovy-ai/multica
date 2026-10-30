import { useState } from "react";
import { ActionSheetIOS, ActivityIndicator, Alert, Pressable, SectionList, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { localV2SummarySchema } from "@multica/core/local-conversation/v2";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ConnectionNotice } from "@/components/ai-sessions/connection-notice";
import { useAIConnection, useAISessionScope } from "@/data/ai-sessions/hooks";
import { aiKeys } from "@/data/ai-sessions/client";
import { groupSessions } from "@/data/ai-sessions/projection";
import { projectsSchema, providersSchema } from "@/data/ai-sessions/schemas";
import { useT } from "@/lib/i18n";
import { createRequestId } from "@/lib/request-id";
import { aiDraftKey } from "@/data/ai-sessions/drafts";
import { useAIViewPreferences } from "@/data/ai-sessions/preferences";

export default function AISessionList() {
  const { t } = useT("aiSessions");
  const { workspace, device, name } = useLocalSearchParams<{ workspace: string; device: string; name?: string }>();
  const { client, connected } = useAIConnection();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const scope = useAISessionScope();
  const collapsed = useAIViewPreferences((s) => s.collapsed);
  const toggle = useAIViewPreferences((s) => s.toggle);
  const base = aiKeys.scope(scope);
  const sessions = useQuery({ queryKey: [...base, "list"], enabled: !!client, retry: false, queryFn: ({ signal }) => client!.list(signal) });
  const projects = useQuery({ queryKey: [...base, "projects"], enabled: !!client && connected, queryFn: ({ signal }) => client!.request("GET", "/folder-projects", projectsSchema, undefined, signal) });
  const providers = useQuery({ queryKey: [...base, "providers"], enabled: !!client && connected, queryFn: ({ signal }) => client!.request("GET", "/providers", providersSchema, undefined, signal) });
  const create = useMutation({ mutationFn: async ({ provider, project }: { provider: string; project?: string }) => client!.request("POST", "/sessions", localV2SummarySchema, { id: `ios-${createRequestId()}`, provider, title: t("new"), folder_project_id: project }),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: aiKeys.list(client!.scope) });
      router.push({ pathname: "/[workspace]/ai-sessions/[device]/[session]", params: { workspace, device, session: created.conversation_id, name } });
    }, onError: () => Alert.alert(t("error_title"), t("operation_failed")),
  });
  const newConversation = (project?: string) => {
    const available = providers.data?.providers.filter((p) => p.available) ?? [];
    if (!available.length) { Alert.alert(t("error_title"), t("no_provider")); return; }
    if (available.length === 1) { create.mutate({ provider: available[0].id, project }); return; }
    ActionSheetIOS.showActionSheetWithOptions({ options: [t("cancel"), ...available.map((p) => p.name)], cancelButtonIndex: 0, title: t("provider") }, (index) => {
      if (index > 0) create.mutate({ provider: available[index - 1].id, project });
    });
  };
  const sections = groupSessions(sessions.data ?? [], projects.data?.projects ?? [], search, archived, String(t("unassigned"))).map((section) => {
    const key = aiDraftKey(scope, section.id ?? "unassigned");
    return { ...section, key, count: section.data.length, collapsed: !search.trim() && !!collapsed[key], data: !search.trim() && collapsed[key] ? [] : section.data };
  });
  return <View className="flex-1 bg-background">
    <Stack.Screen options={{ title: name || t("sessions"), headerRight: () => <View className="flex-row"><IconButton name="folder-open-outline" accessibilityLabel={t("new_project")} disabled={!connected} onPress={() => router.push({ pathname: "/[workspace]/ai-sessions/[device]/folders", params: { workspace, device } })} /><IconButton name="add" accessibilityLabel={t("new")} disabled={!connected || create.isPending} onPress={() => newConversation()} /></View> }} />
    <ConnectionNotice connected={connected} />
    <View className="px-4 py-3"><TextField value={search} onChangeText={setSearch} placeholder={t("search")} accessibilityLabel={t("search")} /></View>
    {sessions.isPending ? <ActivityIndicator /> : <SectionList sections={sections} keyExtractor={(s) => s.conversation_id}
      refreshing={sessions.isRefetching} onRefresh={() => void sessions.refetch()} stickySectionHeadersEnabled={false}
      ListEmptyComponent={<View className="p-6 gap-3"><Text className="text-muted-foreground">{t(search ? "empty_search" : "empty_sessions")}</Text>{sessions.isError === true && <Button variant="outline" onPress={() => void sessions.refetch()}><Text>{t("retry")}</Text></Button>}</View>}
      renderSectionHeader={({ section }) => <View className="flex-row items-center mx-4 mt-3 px-3 py-2 rounded-md"><Pressable className="flex-1 flex-row items-center gap-2 py-2" accessibilityRole="button" accessibilityState={{ expanded: !section.collapsed }} onPress={() => toggle(section.key)}><Text className="flex-1 text-sm font-medium">{section.title}</Text><Text className="text-xs text-muted-foreground">{section.count} {section.collapsed ? "›" : "⌄"}</Text></Pressable><IconButton name="add" accessibilityLabel={t("new")} disabled={!connected || create.isPending} onPress={() => newConversation(section.id ?? undefined)} /></View>}
      renderItem={({ item }) => <Pressable className="mx-4 px-3 py-4 border-b border-border active:bg-secondary" accessibilityRole="button"
        onPress={() => router.push({ pathname: "/[workspace]/ai-sessions/[device]/[session]", params: { workspace, device, session: item.conversation_id, name } })}>
        <Text className="font-medium text-base" numberOfLines={1}>{item.pinned ? "📌 " : ""}{item.title}</Text><Text className="text-xs text-muted-foreground mt-1" numberOfLines={1}>{item.provider === "claude" ? "Claude Code" : item.provider === "codex" ? "Codex" : item.provider} · {item.last_message_preview}</Text>
      </Pressable>}
    />}
    <View className="px-4 py-3 flex-row items-center border-t border-border"><Text className="flex-1 text-xs text-muted-foreground">{t("saved_on", { device: name || t("device_name") })}</Text><Button variant="ghost" size="sm" onPress={() => setArchived((s) => !s)}><Text>{t(archived ? "history" : "archived")}</Text></Button></View>
  </View>;
}
