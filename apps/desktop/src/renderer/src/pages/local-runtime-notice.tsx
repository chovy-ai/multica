import { useEffect, useSyncExternalStore } from "react";
import { Alert, AlertDescription } from "@multica/ui/components/ui/alert";
import type { LocalConversationScope } from "@multica/tutti-agent-gui-host/local-protocol";
import { getLocalConversationClient, localRuntimeRestartMessage } from "../platform/local-conversation-client";

export function LocalRuntimeNotice({ scope, chinese }: { scope: LocalConversationScope; chinese: boolean }) {
  const client = getLocalConversationClient(window.desktopAPI.localConversations);
  const outdated = useSyncExternalStore(client.subscribeCompatibility, () => client.needsRestart(scope));
  const { userId, workspaceId } = scope;
  useEffect(() => { void client.check({ userId, workspaceId }).catch(() => { /* Ordinary IPC errors are surfaced by the requesting operation. */ }); }, [client, userId, workspaceId]);
  if (!outdated) return null;
  return <div className="shrink-0 px-4 py-2"><Alert><AlertDescription>{localRuntimeRestartMessage(chinese)}</AlertDescription></Alert></div>;
}
