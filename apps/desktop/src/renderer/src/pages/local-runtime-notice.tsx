import { useEffect, useState, useSyncExternalStore } from "react";
import { Alert, AlertDescription } from "@multica/ui/components/ui/alert";
import type { LocalConversationScope } from "@multica/core/local-conversation/protocol";
import { getLocalConversationClient, localRuntimeRestartMessage } from "../platform/local-conversation-client";
import { localHostAvailabilityMessage, type LocalHostAvailability } from "../../../shared/local-host-availability";

export function LocalRuntimeNotice({ scope, chinese }: { scope: LocalConversationScope; chinese: boolean }) {
  const client = getLocalConversationClient(window.desktopAPI.localConversations);
  const outdated = useSyncExternalStore(client.subscribeCompatibility, () => client.needsRestart(scope));
  const { userId, workspaceId } = scope;
  useEffect(() => { void client.check({ userId, workspaceId }).catch(() => { /* Ordinary IPC errors are surfaced by the requesting operation. */ }); }, [client, userId, workspaceId]);
  const [availability, setAvailability] = useState<LocalHostAvailability | null>(null);
  useEffect(() => {
    let current = true;
    void window.desktopAPI.localHost.availability().then((value) => { if (current && value) setAvailability(value); });
    const unsubscribe = window.desktopAPI.localHost.subscribe(setAvailability);
    return () => { current = false; unsubscribe(); };
  }, []);
  const message = outdated ? localRuntimeRestartMessage(chinese) : localHostAvailabilityMessage(availability, chinese);
  if (!message) return null;
  return <div className="shrink-0 px-4 py-2"><Alert><AlertDescription>{message}</AlertDescription></Alert></div>;
}
