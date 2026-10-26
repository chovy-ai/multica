import { translate, type TranslateFn } from "../i18n/index";
import type { WorkspaceAgentActivityStatus } from "./workspaceAgentActivityListViewModel";

export function normalizeWorkspaceAgentActivityDisplayStatus(
  status: string | undefined
): WorkspaceAgentActivityStatus {
  switch ((status ?? "").trim().toLowerCase()) {
    case "working":
      return "working";
    case "waiting":
      return "waiting";
    case "idle":
    case "ready":
      return "completed";
    case "completed":
    case "end":
      return "completed";
    case "canceled":
      return "canceled";
    case "failed":
      return "failed";
    default:
      return "idle";
  }
}

export function workspaceAgentActivityStatusLabel(
  status: WorkspaceAgentActivityStatus | string,
  t?: TranslateFn
): string {
  const translateFn = t ?? translate;
  switch (normalizeWorkspaceAgentActivityDisplayStatus(status)) {
    case "working":
      return translateFn("agentHost.workspaceAgentActivityStatusWorking");
    case "waiting":
      return translateFn("agentHost.workspaceAgentActivityStatusWaiting");
    case "idle":
      return translateFn("agentHost.workspaceAgentActivityStatusIdle");
    case "completed":
      return translateFn("agentHost.workspaceAgentActivityStatusEnd");
    case "canceled":
      return translateFn("agentHost.workspaceAgentActivityStatusCanceled");
    case "failed":
      return translateFn("agentHost.workspaceAgentActivityStatusFailed");
    default:
      return String(status);
  }
}
