import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Image, Pressable, ScrollView, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { useAIConnection, useAISessionScope } from "@/data/ai-sessions/hooks";
import { aiKeys } from "@/data/ai-sessions/client";
import { openDeviceFile } from "@/data/ai-sessions/files";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { useT } from "@/lib/i18n";

const locationSchema = z.object({ root: z.string(), path: z.string(), name: z.string(), kind: z.string() });
const entriesSchema = z.object({ entries: z.array(locationSchema) });
const fileSchema = z.object({ root: z.string(), path: z.string(), name: z.string(), mime_type: z.string(), size: z.number() });

export function AIFilesContent({ initialPath, onLocation }: { initialPath?: string; onLocation?: (root: string, path: string, kind: "file" | "directory") => void }) {
  const { t } = useT("aiSessions");
  const { session } = useLocalSearchParams<{ session: string }>();
  const { client, connected } = useAIConnection();
  const scope = useAISessionScope();
  const snapshot = useQuery({ queryKey: aiKeys.snapshot(scope, session), enabled: !!client && connected, staleTime: Infinity, queryFn: ({ signal }) => client!.snapshot(session, signal) });
  const [location, setLocation] = useState<{ root: string; folder: string; file: string | null } | null>(null);
  const [search, setSearch] = useState("");
  const opened = useRef("");
  const locate = useQuery({ queryKey: [...aiKeys.scope(scope), "locate", session, initialPath], enabled: !!client && connected && !!initialPath,
    queryFn: ({ signal }) => client!.request("GET", `/preview/locate?${new URLSearchParams({ conversation_id: session, path: initialPath! })}`, locationSchema, undefined, signal) });
  const entry = locate.data;
  const current = location ?? (entry ? { root: entry.root, folder: entry.kind === "directory" ? entry.path : entry.root, file: entry.kind === "file" ? entry.path : null } : null);
  const root = current?.root ?? snapshot.data?.conversation.cwd ?? "";
  const folder = current?.folder ?? root;
  const file = current?.file ?? null;
  useEffect(() => { if (root) onLocation?.(root, file ?? folder, file ? "file" : "directory"); }, [root, file, folder, onLocation]);
  const params = new URLSearchParams({ conversation_id: session, root, path: file ?? folder });
  const entries = useQuery({ queryKey: [...aiKeys.scope(scope), "files", session, root, folder], enabled: !!client && connected && !!root && !file,
    queryFn: ({ signal }) => client!.request("GET", `/preview/list?${params}`, entriesSchema, undefined, signal) });
  const preview = useQuery({ queryKey: [...aiKeys.scope(scope), "preview", session, root, file], enabled: !!client && connected && !!file,
    queryFn: async ({ signal }) => {
      const metadata = await client!.request("GET", `/preview/file?${params}`, fileSchema, undefined, signal);
      const path = `/preview/content?${params}`;
      const text = metadata.mime_type.startsWith("text/") || /\.(md|txt|json|ya?ml|tsx?|jsx?|swift|go|css|html|xml|toml|log)$/i.test(metadata.name);
      if (!text) return { metadata, path, content: null };
      const response = await fetch(client!.url(path), { headers: client!.headers(), signal });
      if (!response.ok) throw new Error("preview_error");
      return { metadata, path, content: await response.text() };
    },
  });
  const open = (share = false) => { if (client && preview.data) void openDeviceFile(client, preview.data.path, preview.data.metadata.name, share).catch(() => Alert.alert(t("error_title"), t("preview_error"))); };
  useEffect(() => {
    const value = preview.data;
    if (client && connected && file && value && value.content === null && !value.metadata.mime_type.startsWith("image/") && opened.current !== value.path) {
      opened.current = value.path;
      void openDeviceFile(client, value.path, value.metadata.name).catch(() => Alert.alert(t("error_title"), t("preview_error")));
    }
  }, [preview.data, client, connected, file, t]);
  const parent = folder.slice(0, Math.max(folder.lastIndexOf("/"), folder.lastIndexOf("\\")));
  const failure = preview.isError || entries.isError || locate.isError || snapshot.isError;
  return <View className="flex-1 bg-background p-4 gap-3">
    <View className="flex-row items-center gap-2"><Text className="text-xs text-muted-foreground flex-1" selectable>{file ?? folder}</Text>{file && <IconButton name="share-outline" accessibilityLabel={t("share")} disabled={!preview.data || !connected} onPress={() => open(true)} />}</View>
    {(file || (folder !== root && parent)) && <Button variant="ghost" onPress={() => { opened.current = ""; setLocation({ root, folder: file ? folder : parent, file: null }); }}><Text>↑ {t("parent")}</Text></Button>}
    {!file && <TextField value={search} onChangeText={setSearch} placeholder={t("search_files")} accessibilityLabel={t("search_files")} />}
    {(file ? preview.isLoading : entries.isLoading) && <ActivityIndicator />}
    {failure && <View className="gap-2"><Text>{t("preview_error")}</Text><Button variant="outline" disabled={!connected} onPress={() => { void snapshot.refetch(); if (initialPath) void locate.refetch(); void (file ? preview.refetch() : entries.refetch()); }}><Text>{t("retry")}</Text></Button></View>}
    {file && preview.data ? preview.data.metadata.mime_type.startsWith("image/") ? <Image source={{ uri: client!.url(preview.data.path), headers: client!.headers() }} resizeMode="contain" style={{ width: "100%", flex: 1 }} /> : preview.data.content !== null ? <ScrollView><Text selectable className="font-mono text-sm">{preview.data.content}</Text></ScrollView> : <Button variant="outline" disabled={!connected} onPress={() => open()}><Text>{t("open_file")}</Text></Button>
      : <FlatList data={entries.data?.entries.filter((entry) => entry.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()))} keyExtractor={(entry) => entry.path} renderItem={({ item }) => <Pressable accessibilityRole="button" className="py-4 border-b border-border active:bg-secondary" onPress={() => { opened.current = ""; setLocation({ root, folder: item.kind === "directory" ? item.path : folder, file: item.kind === "directory" ? null : item.path }); }}><Text>{item.kind === "directory" ? "▸ " : ""}{item.name}</Text></Pressable>} />}
  </View>;
}
