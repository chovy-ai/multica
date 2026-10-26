import type {
  CreateIssueManagerControllerRuntimeInput,
  IssueManagerControllerRuntime
} from "./controllerRuntime.ts";

export type {
  AsyncCollectionState,
  IssueDraft,
  IssueManagerNotificationState,
  TaskDraft
} from "./controllerTypes.ts";
export type {
  CreateIssueManagerControllerRuntimeInput as CreateIssueManagerControllerSessionInput,
  IssueManagerControllerRuntime as IssueManagerControllerSession,
  IssueManagerControllerSnapshot,
  SyncIssueManagerControllerRuntimeInput as IssueManagerControllerSessionSyncInput
} from "./controllerRuntime.ts";
export type {
  IssueManagerEditorMode,
  IssueManagerReferenceTarget
} from "./controllerModel.ts";

export interface IssueManagerControllerService {
  createSession(
    input: CreateIssueManagerControllerRuntimeInput
  ): IssueManagerControllerRuntime;
}
