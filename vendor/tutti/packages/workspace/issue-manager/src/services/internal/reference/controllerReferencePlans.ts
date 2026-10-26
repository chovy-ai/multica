import type {
  IssueManagerEditorMode,
  IssueManagerReferenceTarget
} from "../model.ts";

export function createIssueManagerAttachReferenceTarget(
  parentKind: "issue" | "task",
  selectedTaskId: string | null
): Extract<IssueManagerReferenceTarget, { mode: "attach" }> {
  return parentKind === "task"
    ? {
        mode: "attach",
        parentKind: "task",
        taskId: selectedTaskId ?? ""
      }
    : {
        mode: "attach",
        parentKind: "issue"
      };
}

export function createIssueManagerInsertReferenceTarget(
  parentKind: "issue" | "task",
  selectedTaskId: string | null
): Extract<IssueManagerReferenceTarget, { mode: "insert" }> {
  return parentKind === "task"
    ? {
        mode: "insert",
        parentKind: "task",
        taskId: selectedTaskId ?? ""
      }
    : {
        mode: "insert",
        parentKind: "issue"
      };
}

export function createIssueManagerAttachReferencesPlan(input: {
  hasFileAdapter: boolean;
  parentKind: "issue" | "task";
  requestReferencesDirectly: boolean;
  selectedTaskId: string | null;
}):
  | {
      kind: "open_picker";
      target: Extract<IssueManagerReferenceTarget, { mode: "attach" }>;
    }
  | {
      kind: "request_directly";
      target: Extract<IssueManagerReferenceTarget, { mode: "attach" }>;
    }
  | { kind: "skip" } {
  if (!input.hasFileAdapter) {
    return { kind: "skip" };
  }
  if (input.parentKind === "task" && !input.selectedTaskId) {
    return { kind: "skip" };
  }

  const target = createIssueManagerAttachReferenceTarget(
    input.parentKind,
    input.selectedTaskId
  );
  return input.requestReferencesDirectly
    ? { kind: "request_directly", target }
    : { kind: "open_picker", target };
}

export function createIssueManagerInsertReferencesPlan(input: {
  hasFileAdapter: boolean;
  parentKind: "issue" | "task";
  requestReferencesDirectly: boolean;
  selectedTaskId: string | null;
  taskEditorMode: IssueManagerEditorMode;
}):
  | {
      kind: "open_picker";
      target: Extract<IssueManagerReferenceTarget, { mode: "insert" }>;
    }
  | {
      kind: "request_directly";
      target: Extract<IssueManagerReferenceTarget, { mode: "insert" }>;
    }
  | { kind: "skip" } {
  if (!input.hasFileAdapter) {
    return { kind: "skip" };
  }
  if (
    input.parentKind === "task" &&
    !input.selectedTaskId &&
    input.taskEditorMode !== "create"
  ) {
    return { kind: "skip" };
  }

  const target = createIssueManagerInsertReferenceTarget(
    input.parentKind,
    input.selectedTaskId
  );
  return input.requestReferencesDirectly
    ? { kind: "request_directly", target }
    : { kind: "open_picker", target };
}
