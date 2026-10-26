import type {
  IssueManagerNotificationState,
  IssueManagerNotificationTone
} from "../../../../services/controllerTypes.ts";

const issueManagerNoticeDurationMs = 3000;

export interface IssueManagerFloatingNoticeViewState {
  durationMs: number;
  id: number;
  isLoading: boolean;
  title: string;
  tone: IssueManagerNotificationTone;
}

export function resolveIssueManagerFloatingNoticeViewState(input: {
  notification: IssueManagerNotificationState | null;
}): IssueManagerFloatingNoticeViewState | null {
  if (!input.notification) {
    return null;
  }

  return {
    durationMs: issueManagerNoticeDurationMs,
    id: input.notification.id,
    isLoading: false,
    title: input.notification.title,
    tone: input.notification.tone
  };
}
