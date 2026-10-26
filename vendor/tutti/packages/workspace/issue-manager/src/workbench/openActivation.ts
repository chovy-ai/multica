import type { WorkbenchHostActivation } from "@tutti-os/workbench-surface";

export const issueManagerOpenActivationType = "open-workspace-issue";

export interface IssueManagerOpenActivationPayload {
  issueId: string;
  mode?: "breakdown" | "execute";
  outputDir?: string;
  runId?: string;
  taskId?: string;
  topicId?: string;
}

export function readIssueManagerOpenActivationPayload(
  activation: WorkbenchHostActivation | null
): IssueManagerOpenActivationPayload | null {
  if (
    activation?.type !== issueManagerOpenActivationType ||
    !activation.payload ||
    typeof activation.payload !== "object"
  ) {
    return null;
  }

  const typed =
    activation.payload as Partial<IssueManagerOpenActivationPayload>;
  const issueId = typed.issueId?.trim() || "";
  if (!issueId) {
    return null;
  }

  return {
    issueId,
    ...(typed.mode === "breakdown" || typed.mode === "execute"
      ? { mode: typed.mode }
      : {}),
    ...(typed.outputDir?.trim() ? { outputDir: typed.outputDir.trim() } : {}),
    ...(typed.runId?.trim() ? { runId: typed.runId.trim() } : {}),
    ...(typed.taskId?.trim() ? { taskId: typed.taskId.trim() } : {}),
    ...(typed.topicId?.trim() ? { topicId: typed.topicId.trim() } : {})
  };
}
