import type { JSX } from "react";
import { renderAtlassianMcp } from "./agentAtlassianRenderers";
import { renderContext7Mcp } from "./agentContext7Renderers";
import type { AgentMcpNormalizedPayload } from "./agentMcpShared";

export function renderRegisteredMcp(
  payload: AgentMcpNormalizedPayload
): JSX.Element | null {
  const identity =
    `${payload.server ?? ""} ${payload.tool ?? ""}`.toLowerCase();
  if (
    identity.includes("jira") ||
    identity.includes("confluence") ||
    identity.includes("atlassian")
  ) {
    return renderAtlassianMcp(payload);
  }
  if (identity.includes("context7")) {
    return renderContext7Mcp(payload);
  }
  return null;
}
