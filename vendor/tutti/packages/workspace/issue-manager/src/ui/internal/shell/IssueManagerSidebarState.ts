import type { IssueManagerSidebarViewState } from "./IssueManagerShellState.ts";

export type IssueManagerSidebarPresentationState =
  | {
      body: string;
      kind: "empty";
    }
  | {
      kind: "error";
      retryLabel: string;
      title: string;
    }
  | {
      kind: "none";
    };

export function resolveIssueManagerSidebarPresentationState(input: {
  showStandaloneState: boolean;
  sidebarViewState: IssueManagerSidebarViewState;
}): IssueManagerSidebarPresentationState {
  const { showStandaloneState, sidebarViewState } = input;

  if (!showStandaloneState) {
    return { kind: "none" };
  }

  if (sidebarViewState.kind === "error") {
    return {
      kind: "error",
      retryLabel: sidebarViewState.retryLabel,
      title: sidebarViewState.title
    };
  }

  if (sidebarViewState.kind === "empty") {
    return {
      body: sidebarViewState.body,
      kind: "empty"
    };
  }

  return { kind: "none" };
}
