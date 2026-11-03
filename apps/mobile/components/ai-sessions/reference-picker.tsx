import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams } from "expo-router";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { ScopeButtons } from "@/components/ui/scope-buttons";
import { ActorAvatar } from "@/components/ui/actor-avatar";
import { useT } from "@/lib/i18n";
import { useColorScheme } from "@/lib/use-color-scheme";
import { THEME } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useNativeSearchBar } from "@/lib/use-native-search-bar";
import { useAIConnection, useAISessionScope } from "@/data/ai-sessions/hooks";
import { aiKeys } from "@/data/ai-sessions/client";
import { aiDraftKey, useAIDrafts } from "@/data/ai-sessions/drafts";
import { EMPTY_REFERENCES, MAX_REFERENCES, REFERENCE_KINDS, referenceKey, type ReferenceKind } from "@/data/ai-sessions/references";
import { referencePageOptions, type ReferencePage } from "@/data/ai-sessions/reference-queries";

export function AIReferencePicker() {
  const { session = "", name, query: initialQuery = "", tokenStart, tokenEnd } = useLocalSearchParams<{ session: string; name?: string; query?: string; tokenStart?: string; tokenEnd?: string }>();
  const scope = useAISessionScope();
  const key = aiDraftKey(scope, session);
  const { client, connected } = useAIConnection();
  const qc = useQueryClient();
  const { t } = useT("aiSessions");
  const { colorScheme } = useColorScheme();
  const theme = THEME[colorScheme];
  const [kind, setKind] = useState<ReferenceKind>("session");
  const search = useNativeSearchBar(t("references.search"), { autoFocus: true, initialQuery });
  const [query, setQuery] = useState(initialQuery.trim());
  const selected = useAIDrafts((state) => state.references[key] ?? EMPTY_REFERENCES);
  const toggle = useAIDrafts((state) => state.toggleReference);
  const locked = useAIDrafts((state) => !!state.pending[key]);
  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()), 200); return () => clearTimeout(timer); }, [search]);
  const options = client ? referencePageOptions(client, qc, session, kind, query) : {
    queryKey: [...aiKeys.scope(scope), "references"], initialPageParam: 0,
    queryFn: async (): Promise<ReferencePage> => { throw new Error("device_unreachable"); },
    getNextPageParam: (page: ReferencePage) => page.nextOffset,
  };
  const result = useInfiniteQuery({ ...options, enabled: !!client && !!scope.workspaceId && !!session && connected, staleTime: 30_000 });
  const items = useMemo(() => [...new Map((result.data?.pages.flatMap((page) => page.items) ?? []).map((item) => [referenceKey(item), item])).values()], [result.data]);
  const searching = query !== search.trim();
  return <FlatList key={kind + query} data={searching ? [] : items} keyExtractor={referenceKey} className="flex-1 bg-background" keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets contentInsetAdjustmentBehavior="automatic"
      ListHeaderComponent={<View className="px-4 pt-2 pb-2 gap-2 bg-background"><ScopeButtons<ReferenceKind> options={REFERENCE_KINDS.map((value) => ({ value, label: t(`references.${value}`) }))} value={kind} onChange={setKind} />{!connected && <Text style={{ lineHeight: undefined }} accessibilityRole="alert" className="text-sm text-muted-foreground">{t("offline_help")}</Text>}<View className="flex-row flex-wrap justify-between gap-x-3 gap-y-1 py-2"><Text style={{ lineHeight: undefined }} className="text-xs text-muted-foreground">{t(kind === "session" ? "references.session_heading" : kind === "issue" ? "references.issue_heading" : "references.agent_heading", { device: name || t("device_name") })}</Text><Text style={{ lineHeight: undefined }} accessibilityLiveRegion="polite" className="text-xs text-muted-foreground">{t(selected.length === MAX_REFERENCES ? "references.limit" : "references.count", { count: selected.length, max: MAX_REFERENCES })}</Text></View></View>}
      renderItem={({ item }) => {
        const checked = selected.some((entry) => referenceKey(entry) === referenceKey(item));
        const disabled = locked || !session || !scope.workspaceId || (!checked && (!!item.unavailable || selected.length >= MAX_REFERENCES));
        const detail = item.kind === "agent" ? t(item.unavailable ? `references.${item.unavailable}` : "references.available") : item.detail;
        return <Pressable accessibilityRole="checkbox" accessibilityLabel={`${item.name}, ${detail}`} accessibilityState={{ checked, disabled }} disabled={disabled} onPress={() => toggle(key, { kind: item.kind, id: item.id, name: item.name }, tokenStart !== undefined && tokenEnd !== undefined ? { query: initialQuery, start: Number(tokenStart), end: Number(tokenEnd) } : undefined)} className={cn("min-h-16 flex-row items-center gap-3 px-4 py-3 active:bg-secondary", disabled && "opacity-50")}>
          {item.kind === "agent" && <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants"><ActorAvatar type="agent" id={item.id} name={item.name} size={36} /></View>}
          <View className="flex-1 gap-1"><Text style={{ lineHeight: undefined }} className="text-base font-medium" numberOfLines={1}>{item.name}</Text><Text style={{ lineHeight: undefined }} className="text-xs text-muted-foreground" numberOfLines={1}>{detail}</Text></View>
          <View className="w-5">{checked && <Ionicons name="checkmark" size={20} color={theme.primary} />}</View>
        </Pressable>;
      }}
      ListEmptyComponent={searching || (result.isPending && connected) ? <ActivityIndicator className="py-6" /> : !result.isError && connected ? <Text style={{ lineHeight: undefined }} className="p-6 text-center text-muted-foreground">{t("references.empty")}</Text> : null}
      ListFooterComponent={<View className="px-4 py-2">
        {result.isError ? <><Text style={{ lineHeight: undefined }} accessibilityRole="alert" className="text-sm text-destructive">{t("references.load_failed")}</Text><Button style={{ height: "auto", minHeight: 40 }} hitSlop={2} variant="ghost" disabled={!connected || result.isFetching} onPress={() => void (result.isFetchNextPageError ? result.fetchNextPage() : result.refetch())}><Text style={{ lineHeight: undefined }}>{t("retry")}</Text></Button></>
          : !searching && result.hasNextPage ? <Button style={{ height: "auto", minHeight: 40 }} hitSlop={2} variant="ghost" disabled={!connected || result.isFetching} onPress={() => void result.fetchNextPage()}>{result.isFetchingNextPage ? <ActivityIndicator /> : null}<Text style={{ lineHeight: undefined }}>{t(result.isFetchingNextPage ? "references.loading" : "references.load_more")}</Text></Button>
          : items.length > 0 && !result.isPending && !searching ? <Text style={{ lineHeight: undefined }} className="py-3 text-center text-xs text-muted-foreground">{t("references.loaded")}</Text> : null}
      </View>}
    />;
}
