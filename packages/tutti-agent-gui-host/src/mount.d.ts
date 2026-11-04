// Consumers see this declaration, not the GUI's sources, so they do not
// type-check the vendored tree under their own compiler options.
import type { ComponentType } from "react";
import type { AgentGuiInitSnapshot, AgentGuiRpcClient } from "./protocol";

export interface AgentGuiMountProps {
  client: AgentGuiRpcClient;
  initial: AgentGuiInitSnapshot;
  onRendered?: () => void;
}

declare const AgentGuiMount: ComponentType<AgentGuiMountProps>;
export default AgentGuiMount;
