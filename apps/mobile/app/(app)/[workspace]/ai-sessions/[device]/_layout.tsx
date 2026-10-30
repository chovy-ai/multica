import { SHEET_OPTIONS } from "@/lib/sheet-options";
import { Stack } from "expo-router";
import { AIConnectionProvider } from "@/data/ai-sessions/hooks";
import { useT } from "@/lib/i18n";

export default function AIComputerLayout() {
  const { t } = useT("aiSessions");
  return <AIConnectionProvider><Stack screenOptions={{ headerBackTitle: t("sessions") }}>
    <Stack.Screen name="index" options={{ title: t("sessions"), headerBackTitle: t("title") }} />
    <Stack.Screen name="[session]" options={{ title: t("new") }} />
    <Stack.Screen name="folders" options={SHEET_OPTIONS} />
    <Stack.Screen name="models" options={SHEET_OPTIONS} />
    <Stack.Screen name="queue" options={SHEET_OPTIONS} />
    <Stack.Screen name="usage" options={SHEET_OPTIONS} />
    <Stack.Screen name="files" options={{ title: t("files") }} />
    <Stack.Screen name="side" options={{ title: t("side") }} />
  </Stack></AIConnectionProvider>;
}
