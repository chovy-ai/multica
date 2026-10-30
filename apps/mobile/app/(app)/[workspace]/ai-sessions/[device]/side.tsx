import { useCallback, useEffect, useRef, useState } from "react";
import { ActionSheetIOS, Alert, Share, View } from "react-native";
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { WebView, type DomWebViewRef } from "@expo/dom-webview";
import { localV2SummarySchema, type LocalV2Snapshot } from "@multica/core/local-conversation/v2";
import { z } from "zod";
import { aiKeys } from "@/data/ai-sessions/client";
import { aiDraftKey } from "@/data/ai-sessions/drafts";
import { useAIConnection, useAISessionScope } from "@/data/ai-sessions/hooks";
import { remoteWebURL } from "@/data/ai-sessions/files";
import { useAIViewPreferences } from "@/data/ai-sessions/preferences";
import { AISessionContent } from "@/components/ai-sessions/session-content";
import { AIFilesContent } from "@/components/ai-sessions/files-content";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { useT } from "@/lib/i18n";
import { createRequestId } from "@/lib/request-id";

const workspaceStateSchema = z.object({ workspace: z.object({ revision: z.number().int() }).nullable() });
const revisionSchema = z.object({ revision: z.number().int() });
export default function AISideWorkspace() {
  const { t } = useT("aiSessions");
  const { workspace, device, session, sideId, tab, url, path, name } = useLocalSearchParams<{ workspace: string; device: string; session: string; sideId?: string; tab?: string; url?: string; path?: string; name?: string }>();
  const scope = useAISessionScope();
  const { client, connected } = useAIConnection();
  const qc = useQueryClient();
  const key = aiDraftKey(scope, session);
  const layout = useAIViewPreferences((s) => s.layouts[key]);
  const setLayout = useAIViewPreferences((s) => s.setLayout);
  const selected = layout?.tab ?? "files";
  const address = layout?.url;
  const activeSide = layout?.sideId;
  const [input, setInput] = useState<string | null>(null);
  const entered = input ?? (url && remoteWebURL(url) ? url : address) ?? "";
  const [active, setActive] = useState(false);
  useFocusEffect(useCallback(() => { setActive(true); return () => setActive(false); }, []));
  useEffect(() => {
    if (tab === "files" || tab === "web" || tab === "side") setLayout(key, { tab });
    if (sideId) setLayout(key, { sideId });
    if (url && remoteWebURL(url)) setLayout(key, { url: remoteWebURL(url)! });
  }, [key, sideId, tab, url, setLayout]);
  const source = useQuery({ queryKey: aiKeys.snapshot(scope, session), enabled: !!client && connected, staleTime: Infinity, queryFn: ({ signal }) => client!.snapshot(session, signal) });
  const sessions = useQuery({ queryKey: aiKeys.list(scope), enabled: !!client && connected, queryFn: ({ signal }) => client!.list(signal) });
  const state = useQuery({ queryKey: [...aiKeys.scope(scope), "side-workspace", session], enabled: !!client && connected && active, queryFn: ({ signal }) => client!.request("GET", `/sessions/${encodeURIComponent(session)}/side-workspace`, workspaceStateSchema, undefined, signal) });
  const revision = useRef(0);
  const lastWorkspace = useRef<Record<string, unknown> | null>(null);
  const [location, setLocation] = useState<{ root: string; path: string; kind: "file" | "directory" } | null>(null);
  const onLocation = useCallback((root: string, path: string, kind: "file" | "directory") => setLocation((old) => old?.root === root && old.path === path && old.kind === kind ? old : { root, path, kind }), []);
  useEffect(() => {
    if (!client || !connected || !state.isSuccess || !source.data) return;
    const root = location?.root ?? source.data.conversation.cwd;
    const tabs: Record<string, unknown>[] = root ? [{ id: "ios-files", kind: "file", root, path: location?.path ?? root, fileKind: location?.kind ?? "directory" }] : [];
    if (address) tabs.push({ id: "ios-web", kind: "web", url: address });
    if (activeSide) tabs.push({ id: "ios-side", kind: "side", sessionId: activeSide });
    const id = `ios-${selected}`;
    const selectedTabId = tabs.some((entry) => entry.id === id) ? id : null;
    const timer = setTimeout(() => {
      revision.current = Math.max(Date.now(), revision.current + 1, (state.data.workspace?.revision ?? 0) + 1);
      lastWorkspace.current = { conversationId: session, revision: revision.current, panelOpen: active, visible: active, selectedTabId, tabs };
      void client.command(session, { type: "side_workspace_sync", workspace: lastWorkspace.current }, revisionSchema)
        .then((result) => { revision.current = Math.max(revision.current, result.revision); }).catch(() => {});
    }, 150);
    return () => clearTimeout(timer);
  }, [client, connected, session, source.data, state.isSuccess, state.data, selected, address, activeSide, active, location]);
  useEffect(() => () => {
    if (!client || !lastWorkspace.current) return;
    revision.current = Math.max(Date.now(), revision.current + 1);
    void client.command(session, { type: "side_workspace_sync", workspace: { ...lastWorkspace.current, revision: revision.current, visible: false, panelOpen: false } }, revisionSchema).catch(() => {});
  }, [client, session]);
  const web = useRef<DomWebViewRef>(null);
  const newSideRequest = useRef(createRequestId());
  const create = useMutation({ mutationFn: () => client!.command(session, { type: "create_side", request_id: newSideRequest.current }, localV2SummarySchema), onSuccess: (created) => { newSideRequest.current = createRequestId(); setLayout(key, { sideId: created.conversation_id, tab: "side" }); void qc.invalidateQueries({ queryKey: aiKeys.list(scope) }); }, onError: () => Alert.alert(t("error_title"), t("operation_failed")) });
  const chooseSide = () => {
    const sides = sessions.data?.filter((entry) => entry.side_source_id === session) ?? [];
    ActionSheetIOS.showActionSheetWithOptions({ title: t("side_chat"), options: [t("cancel"), t("new"), ...sides.map((entry) => entry.title)], cancelButtonIndex: 0 }, (index) => {
      if (index === 1) create.mutate();
      else if (index > 1) setLayout(key, { sideId: sides[index - 2].conversation_id, tab: "side" });
    });
  };
  const openWeb = () => {
    const value = remoteWebURL(entered.includes("://") ? entered : `https://${entered}`);
    if (!value) { Alert.alert(t("web"), t("local_web")); return; }
    setLayout(key, { url: value, tab: "web" });
  };
  return <View className="flex-1 bg-background">
    <Stack.Screen options={{ title: t("side"), headerBackTitle: t("sessions"), headerRight: () => <IconButton name="close" accessibilityLabel={t("done")} onPress={() => router.back()} /> }} />
    <Text className="text-xs text-muted-foreground text-center py-1">{name || t("device_name")} · {t(connected ? "online" : "offline")}</Text>
    <View className="flex-row border-b border-border px-2">{(["files", "web", "side"] as const).map((value) => <Button className="flex-1" key={value} variant={selected === value ? "secondary" : "ghost"} onPress={() => setLayout(key, { tab: value })}><Text>{t(value === "side" ? "side_chat" : value)}</Text></Button>)}</View>
    <View className="flex-1" style={{ display: selected === "files" ? "flex" : "none" }}><AIFilesContent key={path ?? "root"} initialPath={path} onLocation={onLocation} /></View>
    <View className="flex-1" style={{ display: selected === "web" ? "flex" : "none" }}>
      <View className="flex-row items-center gap-2 px-3 py-2"><View className="flex-1"><TextField value={entered} onChangeText={setInput} autoCapitalize="none" autoCorrect={false} placeholder={t("web_address")} accessibilityLabel={t("web_address")} onSubmitEditing={openWeb} /></View><IconButton name="arrow-forward" accessibilityLabel={t("open_web")} onPress={openWeb} /></View>
      {address && <WebView ref={web} style={{ flex: 1 }} source={{ uri: address }} useExpoModulesBridge={false} />}
      <View className="flex-row justify-between p-2 border-t border-border"><IconButton name="chevron-back" accessibilityLabel={t("parent")} onPress={() => web.current?.injectJavaScript("history.back();")} /><IconButton name="chevron-forward" accessibilityLabel={t("open_web")} onPress={() => web.current?.injectJavaScript("history.forward();")} /><IconButton name="refresh" accessibilityLabel={t("retry")} onPress={() => web.current?.reload()} /><IconButton name="share-outline" accessibilityLabel={t("share")} disabled={!address} onPress={() => { if (address) void Share.share({ url: address }).catch(() => {}); }} /></View>
    </View>
    <View className="flex-1" style={{ display: selected === "side" ? "flex" : "none" }}>
      <Button variant="ghost" disabled={!connected || create.isPending} onPress={chooseSide}><Text>{t("side_chat")}⌄</Text></Button>
      {activeSide ? <AISessionContent key={activeSide} sessionId={activeSide} embedded active={active && selected === "side"} onOpenSource={() => router.dismissTo({ pathname: "/[workspace]/ai-sessions/[device]/[session]", params: { workspace, device, session, name, turn: qc.getQueryData<LocalV2Snapshot>(aiKeys.snapshot(scope, activeSide))?.conversation.side_source_turn_id } })} /> : <Button variant="outline" className="m-4" disabled={!connected || create.isPending} onPress={() => create.mutate()}><Text>{t("new")}</Text></Button>}
    </View>
  </View>;
}
