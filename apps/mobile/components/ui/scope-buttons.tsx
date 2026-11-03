import { ScrollView } from "react-native";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

/** Immediate list scopes, shared with the My Issues toolbar. */
export function ScopeButtons<Value extends string>({ options, value, onChange, className }: {
  options: readonly { value: Value; label: string }[];
  value: Value;
  onChange(value: Value): void;
  className?: string;
}) {
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" className={cn("grow-0 shrink min-w-0", className)} contentContainerStyle={{ gap: 4 }}>
    {options.map((option) => <Button key={option.value} variant="outline" size="sm" hitSlop={{ top: 4, bottom: 4 }} onPress={() => onChange(option.value)} accessibilityState={{ selected: value === option.value }} className={cn("h-auto min-h-9", value === option.value && "bg-accent")}>
      <Text style={{ lineHeight: undefined }} numberOfLines={1} className={value === option.value ? "text-accent-foreground" : "text-muted-foreground"}>{option.label}</Text>
    </Button>)}
  </ScrollView>;
}
