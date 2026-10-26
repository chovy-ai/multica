import { translate, type TranslateFn } from "../i18n/index";

export function roomIssueStatusLabel(status: string, t?: TranslateFn): string {
  const translateFn = t ?? translate;
  switch (status) {
    case "not_started":
      return translateFn("agentHost.roomIssueNode.issueStatusNotStarted");
    case "running":
      return translateFn("agentHost.roomIssueNode.issueStatusRunning");
    case "in_progress":
      return translateFn("agentHost.roomIssueNode.issueStatusInProgress");
    case "pending_acceptance":
      return translateFn(
        "agentHost.roomIssueNode.issueStatusPendingAcceptance"
      );
    case "completed":
      return translateFn("agentHost.roomIssueNode.issueStatusCompleted");
    case "failed":
      return translateFn("agentHost.roomIssueNode.issueStatusFailed");
    case "canceled":
      return translateFn("agentHost.roomIssueNode.issueStatusCanceled");
    default:
      return (
        status || translateFn("agentHost.roomIssueNode.issueStatusUnknown")
      );
  }
}
