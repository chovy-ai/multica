import type { ReactNode } from "react";
import type { IssueManagerRun } from "../contracts/index.ts";
import type { IssueManagerI18nRuntime } from "../i18n/issueManagerI18n.ts";

export interface IssueManagerLatestRunStatusRenderInput {
  canOpenAgentSession: boolean;
  copy: IssueManagerI18nRuntime;
  latestRun: IssueManagerRun;
  title: string;
  onOpenAgentSession?: (run: IssueManagerRun) => Promise<void>;
}

export type IssueManagerLatestRunStatusRenderer = (
  input: IssueManagerLatestRunStatusRenderInput
) => ReactNode;
