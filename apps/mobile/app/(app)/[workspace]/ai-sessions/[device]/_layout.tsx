import { SHEET_OPTIONS } from "@/lib/sheet-options";
import { Stack } from "expo-router";
import { AIConnectionProvider } from "@/data/ai-sessions/hooks";
import { useT } from "@/lib/i18n";

// Direct sheet links need the session list underneath the native modal.
export const unstable_settings = { anchor: "index" } as const;

export default function AIComputerLayout() {
  const { t } = useT("aiSessions");
  return <AIConnectionProvider><Stack screenOptions={{ headerBackTitle: t("sessions") }}>
    <Stack.Screen name="index" options={{ title: t("sessions"), headerBackTitle: t("title") }} />
    <Stack.Screen name="[session]" options={{ title: t("new") }} />
    <Stack.Screen name="folders" options={SHEET_OPTIONS} />
    <Stack.Screen name="models" options={SHEET_OPTIONS} />
    <Stack.Screen name="setting" options={({ route }) => ({ ...SHEET_OPTIONS, headerShown: !!route.params && "kind" in route.params && route.params.kind === "model", title: t("model") })} />
    {/* Search and paginated results need the larger detent. */}
    <Stack.Screen name="references" options={{ ...SHEET_OPTIONS, sheetInitialDetentIndex: 1, headerShown: true, title: t("references.title") }} />
    <Stack.Screen name="queue" options={SHEET_OPTIONS} />
    <Stack.Screen name="usage" options={SHEET_OPTIONS} />
    <Stack.Screen name="files" options={{ title: t("files") }} />
    <Stack.Screen name="side" options={{ title: t("side") }} />
    <Stack.Screen name="side-sessions" options={{ ...SHEET_OPTIONS, headerShown: true, title: t("side_chat") }} />
  </Stack></AIConnectionProvider>;
}
