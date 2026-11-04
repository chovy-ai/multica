import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { router, useLocalSearchParams, useTheme } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAISessionSettings } from "@/data/ai-sessions/settings";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { AISheet } from "@/components/ai-sessions/sheet";
import { useT } from "@/lib/i18n";

export default function AIModels() {
  const { t } = useT("aiSessions");
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ workspace: string; device: string; session: string }>();
  const { snapshot, models, provider, settings, selected, levels, running, connected, disabled } = useAISessionSettings(params.session);
  const permissions: { value: string; label: string }[] = [{ value: "default", label: t("permission_default") }, { value: "auto", label: t("permission_auto") }, { value: "full-access", label: t("permission_full") }];
  const rows: { kind: string; label: string; value: string }[] = [
    { kind: "model", label: t("model"), value: selected?.label ?? settings?.model ?? t("default_model") },
    { kind: "reasoning", label: t("reasoning"), value: levels.find((level) => level.value === settings?.reasoning_effort)?.label ?? settings?.reasoning_effort ?? t("model_default") },
    { kind: "permissions", label: t("permissions"), value: permissions.find((permission) => permission.value === settings?.permission_mode)?.label ?? t("permission_default") },
  ];
  return <AISheet title={t("settings")}>
    <Text style={{ lineHeight: undefined }} className="text-sm text-muted-foreground">{provider === "claude" ? "Claude Code" : provider === "codex" ? "Codex" : provider}</Text>
    {connected && (models.isPending || snapshot.isPending) && <ActivityIndicator />}
    {(models.isError || snapshot.isError) && <Button variant="outline" onPress={() => { void models.refetch(); void snapshot.refetch(); }}><Text>{t("retry")}</Text></Button>}
    <ScrollView className="-mx-2" contentContainerStyle={{ paddingBottom: 16 }}>
      {rows.map((row) => <Pressable key={row.kind} disabled={disabled} accessibilityRole="button" accessibilityState={{ disabled }} onPress={() => router.push({ pathname: "/[workspace]/ai-sessions/[device]/setting", params: { ...params, kind: row.kind } })} className="flex-row items-center gap-3 rounded-lg px-3 py-3 active:bg-secondary">
        <Text style={{ lineHeight: undefined }} className="flex-1">{row.label}</Text>
        <View className="max-w-[50%] flex-row items-center gap-2"><Text style={{ lineHeight: undefined }} className="shrink text-sm text-muted-foreground text-right" numberOfLines={2}>{row.value}</Text><Ionicons name="chevron-forward" size={16} color={colors.text} /></View>
      </Pressable>)}
      {running && <Text style={{ lineHeight: undefined }} className="text-sm text-muted-foreground mt-4">{t("settings_busy")}</Text>}
    </ScrollView>
  </AISheet>;
}
