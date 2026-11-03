import { createContext, useContext } from "react";
import { Button } from "@multica/ui/components/ui/button";

export const ConversationRetryContext = createContext<{
  turnId: string;
  label: string;
  onRetry: () => void;
} | null>(null);

/** The host only offers recovery on the current failed turn. */
export function ConversationRetryButton({ turnId }: { turnId: string }) {
  const action = useContext(ConversationRetryContext);
  if (!action || action.turnId !== turnId) return null;
  return <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={action.onRetry}>
    {action.label}
  </Button>;
}
