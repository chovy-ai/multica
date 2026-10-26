import type { ReactNode } from "react";
import type { AgentSessionEngine } from "@tutti-os/agent-activity-core";
import type { AgentGUIAgentDirectoryPort } from "../types.ts";
import { AgentGuiWorkbenchReactiveHeader } from "./AgentGuiWorkbenchReactiveHeader.tsx";
import type { AgentGuiWorkbenchRailLayoutStore } from "./agentGuiWorkbenchRailLayout.ts";
import { AgentGuiWorkbenchHeader } from "./header.ts";
import type { AgentGuiWorkbenchHeaderProps } from "./header.ts";
import type {
  AgentGuiWorkbenchProvider,
  AgentGuiWorkbenchState
} from "./types.ts";

interface AgentGuiWorkbenchRailAlignedHeaderProps extends AgentGuiWorkbenchHeaderProps {
  agentDirectory: AgentGUIAgentDirectoryPort;
  dockIconUrls?: Partial<Record<AgentGuiWorkbenchProvider, string>>;
  railLayoutStore: AgentGuiWorkbenchRailLayoutStore;
  sessionEngine?: AgentSessionEngine;
  workbenchState: AgentGuiWorkbenchState | null;
}

export function AgentGuiWorkbenchRailAlignedHeader({
  agentDirectory,
  conversationRailWidthPx,
  dockIconUrls,
  nodeId,
  providerRailWidthPx,
  railLayoutStore,
  sessionEngine,
  workbenchState,
  ...headerProps
}: AgentGuiWorkbenchRailAlignedHeaderProps): ReactNode {
  const liveHeaderProps = {
    ...headerProps,
    conversationRailWidthPx,
    nodeId,
    onHeaderElementChange: railLayoutStore.getHeaderElementRef(nodeId),
    providerRailWidthPx
  } satisfies AgentGuiWorkbenchHeaderProps;

  return sessionEngine ? (
    <AgentGuiWorkbenchReactiveHeader
      {...liveHeaderProps}
      agentDirectory={agentDirectory}
      dockIconUrls={dockIconUrls}
      sessionEngine={sessionEngine}
      workbenchState={workbenchState}
    />
  ) : (
    <AgentGuiWorkbenchHeader {...liveHeaderProps} />
  );
}
