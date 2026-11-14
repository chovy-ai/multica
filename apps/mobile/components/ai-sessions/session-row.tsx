import { ActivityIndicator, Pressable, View } from "react-native";
import { useColorScheme } from "nativewind";
import type { LocalV2Summary } from "@multica/core/local-conversation/v2";
import { Text } from "@/components/ui/text";
import { ProviderLogo } from "./provider-logo";
import { aiSessionPreview } from "@/data/ai-sessions/preview";
import { sessionListActivity } from "@/data/ai-sessions/list-activity";
import { useT } from "@/lib/i18n";
import { THEME } from "@/lib/theme";

export function AISessionRow({ item, completionReadSupported, onPress }: {
  item: LocalV2Summary;
  completionReadSupported: boolean;
  onPress: () => void;
}) {
  const { t } = useT("aiSessions");
  const { colorScheme } = useColorScheme();
  const theme = THEME[colorScheme ?? "light"];
  const activity = sessionListActivity(item);
  const activityLabel = activity ? String(t(activity)) : null;
  const unread = completionReadSupported && item.has_unread_completion === true;
  return <Pressable className="mx-4 px-3 py-4 flex-row items-center gap-3 border-x border-b border-border bg-surface-1 active:bg-secondary"
    accessibilityRole="button"
    accessibilityLabel={[item.title, activityLabel, unread ? t("unread_result") : null].filter(Boolean).join(", ")}
    onPress={onPress}>
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" className="w-8 h-8 shrink-0 items-center justify-center">
      <ProviderLogo provider={item.provider} color={theme.foreground} />
    </View>
    <View className="flex-1 min-w-0">
      <Text style={{ lineHeight: undefined }} className="font-medium text-title-sm" numberOfLines={1}>{item.pinned ? "📌 " : ""}{item.title}</Text>
      <Text style={{ lineHeight: undefined }} className="text-caption text-muted-foreground mt-1" numberOfLines={1}>{item.provider === "claude" ? "Claude Code" : item.provider === "codex" ? "Codex" : item.provider} · {aiSessionPreview(item.last_message_preview)}</Text>
    </View>
    <View className="max-w-32 shrink-0 items-end gap-2">
      {activityLabel && <View className="flex-row items-center gap-2">
        {activity !== "pending_question" && <ActivityIndicator accessible={false} size="small" color={theme.mutedForeground} />}
        <Text style={{ lineHeight: undefined }} className="shrink text-right text-caption text-muted-foreground">{activityLabel}</Text>
      </View>}
      {(unread || !activityLabel) && <View className="w-2 h-2">{unread && <View className="w-2 h-2 rounded-full bg-brand" />}</View>}
    </View>
  </Pressable>;
}
