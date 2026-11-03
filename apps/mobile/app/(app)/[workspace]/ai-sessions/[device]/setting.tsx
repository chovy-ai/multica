import { useEffect, useRef } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, View } from "react-native";
import { router, useLocalSearchParams, useNavigation, useTheme } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { aiKeys } from "@/data/ai-sessions/client";
import { useAISessionSettings } from "@/data/ai-sessions/settings";
import { commandResultSchema } from "@/data/ai-sessions/schemas";
import { AISheet } from "@/components/ai-sessions/sheet";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useNativeSearchBar } from "@/lib/use-native-search-bar";
import { useT } from "@/lib/i18n";

type SettingKind = "model" | "reasoning" | "permissions";

export default function AISettingRoute() {
  const { kind } = useLocalSearchParams<{ kind?: string }>();
  return kind === "model" ? <ModelPicker /> : <SettingPicker kind={kind === "permissions" ? "permissions" : "reasoning"} />;
}

function ModelPicker() {
  const { t } = useT("aiSessions");
  const query = useNativeSearchBar(t("model"), { autoFocus: true });
  return <SettingPicker kind="model" query={query} />;
}

function SettingPicker({ kind, query = "" }: { kind: SettingKind; query?: string }) {
  const { t } = useT("aiSessions");
  const { colors } = useTheme();
  const { session } = useLocalSearchParams<{ session: string }>();
  const navigation = useNavigation();
  const list = useRef<ScrollView>(null);
  useEffect(() => { list.current?.scrollTo({ y: 0, animated: false }); }, [query]);
  const state = useAISessionSettings(session);
  const qc = useQueryClient();
  const change = useMutation({ mutationFn: (patch: Record<string, unknown>) => state.client!.command(session, { type: "update_settings", ...patch }, commandResultSchema),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: aiKeys.snapshot(state.scope, session) }); if (navigation.isFocused()) router.back(); },
    onError: () => Alert.alert(t("error_title"), t("operation_failed")),
  });
  const options: { value: string; label: string; help?: string; patch: Record<string, unknown> }[] = kind === "model"
    ? [{ value: "", label: t("default_model"), patch: { model: null, reasoning_effort: null } }, ...(state.models.data?.models ?? []).map((model) => ({ value: model.id, label: model.label, patch: { model: model.id, reasoning_effort: null } }))]
    : kind === "reasoning"
      ? [{ value: "", label: t("model_default"), patch: { reasoning_effort: null } }, ...state.levels.map((level) => ({ value: level.value, label: level.label, patch: { reasoning_effort: level.value } }))]
      : [{ value: "default", label: t("permission_default"), help: t("permission_default_help"), patch: { permission_mode: "default" } }, { value: "auto", label: t("permission_auto"), help: t("permission_auto_help"), patch: { permission_mode: "auto" } }, { value: "full-access", label: t("permission_full"), help: t("permission_full_help"), patch: { permission_mode: "full-access" } }];
  const value = kind === "model" ? state.settings?.model ?? "" : kind === "reasoning" ? state.settings?.reasoning_effort ?? "" : state.settings?.permission_mode ?? "default";
  const disabled = state.disabled || change.isPending;
  const filtered = options.filter((option) => option.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const content = <>
    {state.connected && (state.snapshot.isPending || state.models.isPending || change.isPending) && <ActivityIndicator />}
    {(state.models.isError || state.snapshot.isError) && <Button variant="outline" onPress={() => { void state.models.refetch(); void state.snapshot.refetch(); }}><Text>{t("retry")}</Text></Button>}
    <ScrollView ref={list} className={kind === "model" ? "px-2" : undefined} contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 16 }}>
      {filtered.map((option) => <Pressable key={option.value} disabled={disabled} accessibilityRole="radio" accessibilityState={{ checked: value === option.value, disabled }} onPress={() => change.mutate(option.patch)} className="flex-row items-center gap-3 rounded-lg px-3 py-3 active:bg-secondary">
        <View className="flex-1 gap-1"><Text style={{ lineHeight: undefined }}>{option.label}</Text>{option.help && <Text style={{ lineHeight: undefined }} className="text-xs text-muted-foreground">{option.help}</Text>}</View>
        {value === option.value && <Ionicons name="checkmark" size={20} color={colors.text} />}
      </Pressable>)}
      {!!query.trim() && !filtered.length && <Text className="py-6 text-sm text-center text-muted-foreground">{t("empty_search")}</Text>}
      {kind === "reasoning" && !state.settings?.model && <Text className="px-3 py-3 text-sm text-muted-foreground">{t("reasoning_choose_model")}</Text>}
      {state.running && <Text className="px-3 py-3 text-sm text-muted-foreground">{t("settings_busy")}</Text>}
    </ScrollView>
  </>;
  return kind === "model" ? <>{content}</> : <AISheet title={t(kind)}><View className="flex-1 -mx-2">{content}</View></AISheet>;
}
