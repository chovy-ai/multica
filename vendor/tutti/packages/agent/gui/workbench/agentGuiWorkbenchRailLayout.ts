import type { AgentGUIConversationRailLayout } from "../agent-gui/agentGuiNode/view/AgentGUINodeView.types.ts";

type HeaderElementRef = (element: HTMLElement | null) => void;

export interface AgentGuiWorkbenchRailLayoutStore {
  getHeaderElementRef(nodeId: string): HeaderElementRef;
  report(nodeId: string, layout: AgentGUIConversationRailLayout): void;
}

export function createAgentGuiWorkbenchRailLayoutStore(): AgentGuiWorkbenchRailLayoutStore {
  const layoutsByNodeId = new Map<string, AgentGUIConversationRailLayout>();
  const headerElementsByNodeId = new Map<string, HTMLElement>();
  const headerElementRefsByNodeId = new Map<string, HeaderElementRef>();

  const applyLayout = (
    element: HTMLElement,
    layout: AgentGUIConversationRailLayout
  ): void => {
    element.style.setProperty(
      "--agent-gui-workbench-header-rail-width",
      `${Math.round(layout.leftPanelWidthPx)}px`
    );
  };

  return {
    getHeaderElementRef(nodeId) {
      const existingRef = headerElementRefsByNodeId.get(nodeId);
      if (existingRef) {
        return existingRef;
      }
      const ref: HeaderElementRef = (element) => {
        if (element) {
          headerElementsByNodeId.set(nodeId, element);
          const layout = layoutsByNodeId.get(nodeId);
          if (layout) {
            applyLayout(element, layout);
          }
          return;
        }
        headerElementsByNodeId.delete(nodeId);
        headerElementRefsByNodeId.delete(nodeId);
        layoutsByNodeId.delete(nodeId);
      };
      headerElementRefsByNodeId.set(nodeId, ref);
      return ref;
    },
    report(nodeId, layout) {
      const current = layoutsByNodeId.get(nodeId);
      if (
        current?.conversationRailWidthPx === layout.conversationRailWidthPx &&
        current?.leftPanelWidthPx === layout.leftPanelWidthPx &&
        current?.providerRailWidthPx === layout.providerRailWidthPx &&
        current?.resizing === layout.resizing
      ) {
        return;
      }
      layoutsByNodeId.set(nodeId, layout);
      const element = headerElementsByNodeId.get(nodeId);
      if (element) {
        applyLayout(element, layout);
      }
    }
  };
}
