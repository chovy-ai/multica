import type {
  IssueManagerFileReference,
  IssueManagerNodeState,
  IssueManagerReferenceBundle
} from "../../../contracts/index.ts";
import { appendIssueManagerWorkspaceReferenceMentionsToContent } from "../../../core/index.ts";
import type { IssueManagerReferenceTarget } from "../model.ts";
import type { IssueDraft, TaskDraft } from "../controllerTypes.ts";
import { resolveIssueManagerReferenceInsertionContent } from "./controllerReferenceCommands.ts";

export interface IssueManagerReferenceOutcome {
  issueDraft?: (current: IssueDraft) => IssueDraft;
  nodeState?: (current: IssueManagerNodeState) => IssueManagerNodeState;
  referenceTarget?: IssueManagerReferenceTarget | null;
  refreshAll?: boolean;
  refreshDetails?: boolean;
  taskDraft?: (current: TaskDraft) => TaskDraft;
}

export function createIssueManagerOpenReferencePickerOutcome(
  target: IssueManagerReferenceTarget
): IssueManagerReferenceOutcome {
  return {
    referenceTarget: target
  };
}

export function createIssueManagerAttachReferencesOutcome(
  attached: boolean
): IssueManagerReferenceOutcome {
  return {
    referenceTarget: null,
    refreshDetails: attached
  };
}

export function createIssueManagerInsertReferencesOutcome(input: {
  refs: IssueManagerFileReference[];
  target: Extract<IssueManagerReferenceTarget, { mode: "insert" }>;
}): IssueManagerReferenceOutcome {
  return input.target.parentKind === "issue"
    ? {
        issueDraft: (current) => ({
          ...current,
          content: resolveIssueManagerReferenceInsertionContent({
            content: current.content,
            refs: input.refs
          })
        }),
        referenceTarget: null
      }
    : {
        referenceTarget: null,
        taskDraft: (current) => ({
          ...current,
          content: resolveIssueManagerReferenceInsertionContent({
            content: current.content,
            refs: input.refs
          })
        })
      };
}

/**
 * 插入模式下确认 picker 的分组结果:松散文件按文件链接追加,项目/分组(bundle)
 * 折叠成单条 `mention://workspace-reference/...` chip 追加,不展开成文件。
 */
export function createIssueManagerInsertReferenceBundlesOutcome(input: {
  files: IssueManagerFileReference[];
  bundles: IssueManagerReferenceBundle[];
  target: Extract<IssueManagerReferenceTarget, { mode: "insert" }>;
  workspaceId: string;
}): IssueManagerReferenceOutcome {
  const applyContent = (content: string): string => {
    const withFiles = resolveIssueManagerReferenceInsertionContent({
      content,
      refs: input.files
    });
    return appendIssueManagerWorkspaceReferenceMentionsToContent(
      withFiles,
      input.bundles.map((bundle) => ({
        source: bundle.source,
        id: bundle.id,
        groupId: bundle.groupId,
        displayName: bundle.displayName,
        iconUrl: bundle.iconUrl,
        fileCount: bundle.fileCount,
        workspaceId: input.workspaceId
      }))
    );
  };

  return input.target.parentKind === "issue"
    ? {
        issueDraft: (current) => ({
          ...current,
          content: applyContent(current.content)
        }),
        referenceTarget: null
      }
    : {
        referenceTarget: null,
        taskDraft: (current) => ({
          ...current,
          content: applyContent(current.content)
        })
      };
}
