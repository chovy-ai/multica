import { extractIssueManagerPlainTextFromContent } from "../../../core/index.ts";
import type {
  IssueManagerIssueSummary,
  IssueManagerTaskSummary
} from "../../../contracts/index.ts";

export function summarizeIssueManagerContent(
  content: string | null | undefined,
  fallback: string
): string {
  const plainText = stripIssueManagerDescriptionTerminalPunctuation(
    extractIssueManagerPlainTextFromContent(content ?? "")
  );
  if (!plainText) {
    return stripIssueManagerDescriptionTerminalPunctuation(fallback);
  }
  if (plainText.length <= 120) {
    return plainText;
  }
  return `${plainText.slice(0, 117)}...`;
}

export function stripIssueManagerDescriptionTerminalPunctuation(
  value: string
): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.endsWith("...") || trimmed.endsWith("…")) {
    return trimmed;
  }
  return trimmed.replace(/[。．.]+$/u, "");
}

export function resolveTaskCreatorLabel(task: IssueManagerTaskSummary): string {
  return resolveIssueManagerCreatorLabel(task);
}

export function resolveIssueManagerCreatorLabel(
  entity:
    | Pick<IssueManagerIssueSummary, "creatorDisplayName" | "creatorUserId">
    | Pick<IssueManagerTaskSummary, "creatorDisplayName" | "creatorUserId">
): string {
  return entity.creatorDisplayName?.trim() || entity.creatorUserId;
}
