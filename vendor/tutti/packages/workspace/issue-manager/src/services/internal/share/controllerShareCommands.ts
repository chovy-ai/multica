import type { IssueManagerFeature } from "../../../core/index.ts";

export function canIssueManagerCreateShareLink(
  shareAdapter: IssueManagerFeature["shareAdapter"]
): shareAdapter is NonNullable<IssueManagerFeature["shareAdapter"]> & {
  createIssueLink: NonNullable<
    NonNullable<IssueManagerFeature["shareAdapter"]>["createIssueLink"]
  >;
} {
  return typeof shareAdapter?.createIssueLink === "function";
}

export async function executeIssueManagerShareSelection(input: {
  issueId: string;
  shareAdapter: NonNullable<IssueManagerFeature["shareAdapter"]> & {
    createIssueLink: NonNullable<
      NonNullable<IssueManagerFeature["shareAdapter"]>["createIssueLink"]
    >;
  };
  taskId: string | null;
  workspaceId: string;
}): Promise<void> {
  const link = await input.shareAdapter.createIssueLink({
    issueId: input.issueId,
    taskId: input.taskId ?? undefined,
    workspaceId: input.workspaceId
  });
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    throw new Error("issue_manager.clipboard_unavailable");
  }
  await navigator.clipboard.writeText(link);
}
