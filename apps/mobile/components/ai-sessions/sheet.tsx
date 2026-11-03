import type { ReactNode } from "react";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Text } from "@/components/ui/text";

/** Shared chrome for the AI settings, queue, folder and usage sheets. */
export function AISheet({ title, trailing, children }: { title: string; trailing?: ReactNode; children: ReactNode }) {
  return <SafeAreaView edges={["bottom"]} className="flex-1 bg-background">
    <View className="shrink-0 flex-row items-center gap-2 px-4 pt-4 pb-3">
      <Text style={{ lineHeight: undefined }} accessibilityRole="header" className="flex-1 text-base font-semibold" numberOfLines={2}>{title}</Text>
      {trailing}
    </View>
    <View className="px-4 gap-3 flex-1">{children}</View>
  </SafeAreaView>;
}
