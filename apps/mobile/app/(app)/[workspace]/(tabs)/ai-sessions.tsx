import { ActivityIndicator, FlatList, Pressable, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Header } from "@/components/ui/header";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useAIDevices } from "@/data/ai-sessions/hooks";
import { useAIDeviceLink } from "@/data/ai-sessions/provider";
import { useWorkspaceStore } from "@/data/workspace-store";
import { useColorScheme } from "@/lib/use-color-scheme";
import { THEME } from "@/lib/theme";
import { useT } from "@/lib/i18n";

export default function AISessionsTab() {
  const { t } = useT("aiSessions");
  const devices = useAIDevices();
  const { endpoint, error, retry } = useAIDeviceLink();
  const slug = useWorkspaceStore((s) => s.currentWorkspaceSlug);
  const { colorScheme } = useColorScheme();
  const theme = THEME[colorScheme];
  return <View className="flex-1 bg-background">
    <Header title={t("title")} />
    {error || devices.isError ? <View className="p-4 gap-3">
      <Text className="text-sm text-foreground">{t(error ?? "connection_failed")}</Text>
      <Button variant="outline" onPress={retry}><Text>{t("retry")}</Text></Button>
    </View> : !endpoint || devices.isPending ? <ActivityIndicator className="mt-8" /> : <FlatList
      data={devices.data} keyExtractor={(item) => item.peer_id}
      refreshing={devices.isRefetching} onRefresh={() => void devices.refetch()}
      ListHeaderComponent={<Text className="px-4 pt-6 pb-2 text-xs text-muted-foreground">{t("computers")}</Text>}
      ListEmptyComponent={<View className="px-6 py-12 gap-3"><Text className="text-base font-medium">{t("empty_devices")}</Text><Text className="text-sm text-muted-foreground">{t("device_help")}</Text></View>}
      renderItem={({ item }) => <Pressable
        className="mx-4 flex-row items-center gap-3 border-b border-border py-4 active:bg-secondary"
        disabled={!item.available}
        accessibilityRole="button" accessibilityState={{ disabled: !item.available }}
        accessibilityLabel={`${item.device_name || t("device_name")}, ${t(item.available ? "online" : item.connected ? "sharing_off" : "offline")}`}
        onPress={() => router.push({ pathname: "/[workspace]/ai-sessions/[device]", params: { workspace: slug!, device: item.peer_id, name: item.device_name } })}>
        <Ionicons name="desktop-outline" size={28} color={theme.foreground} />
        <View className="flex-1 gap-1"><Text className="text-base font-medium" numberOfLines={1}>{item.device_name || item.peer_id.slice(-6)}</Text>
          <View className="flex-row items-center gap-1.5"><View className="size-2 rounded-full" style={{ backgroundColor: item.available ? theme.success : theme.mutedForeground }} /><Text className="text-xs text-muted-foreground">{t(item.available ? "online" : item.connected ? "sharing_off" : "offline")}</Text></View>
        </View>
        {item.available && <Ionicons name="chevron-forward" color={theme.mutedForeground} size={16} />}
      </Pressable>}
    />}
  </View>;
}
