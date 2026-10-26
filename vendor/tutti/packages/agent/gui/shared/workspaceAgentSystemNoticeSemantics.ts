import type { AgentActivityMessageSemantics } from "@tutti-os/agent-activity-core";

type NoticeCommand = NonNullable<
  AgentActivityMessageSemantics["noticeCommand"]
>;
type NoticeCommandStatus = NonNullable<
  AgentActivityMessageSemantics["noticeCommandStatus"]
>;

export interface WorkspaceAgentNoticeCommandSemantics {
  command: NoticeCommand;
  commandStatus: NoticeCommandStatus;
}

export function resolveWorkspaceAgentNoticeCommandSemantics(input: {
  eventId?: string | null;
  messageSemantics?: AgentActivityMessageSemantics;
  payload: Record<string, unknown> | null;
  status?: string | null;
}): WorkspaceAgentNoticeCommandSemantics | null {
  const semanticCommand = noticeCommand(input.messageSemantics?.noticeCommand);
  const semanticCommandStatus = noticeCommandStatus(
    input.messageSemantics?.noticeCommandStatus
  );
  const payloadCommand = noticeCommand(
    recordString(input.payload, "noticeCommand")
  );
  const payloadCommandStatus = noticeCommandStatus(
    recordString(input.payload, "noticeCommandStatus")
  );
  const command = semanticCommand ?? payloadCommand;
  const commandStatus = semanticCommandStatus ?? payloadCommandStatus;
  if (command && commandStatus) {
    return { command, commandStatus };
  }

  const source = recordString(input.payload, "source");
  const hasCompactIdentity =
    source === "compact" ||
    /^(?:claude-sdk:compact:|compaction:)/u.test(input.eventId?.trim() ?? "");
  if (!hasCompactIdentity) {
    return null;
  }
  const legacyCompactStatus =
    compactTitleStatus(recordString(input.payload, "title"), input.status) ??
    (source === "compact" ? compactStreamStatus(input.status) : null);
  if (!legacyCompactStatus) {
    return null;
  }
  return {
    command: "compact",
    commandStatus: legacyCompactStatus
  };
}

function noticeCommand(value: unknown): NoticeCommand | null {
  switch (value) {
    case "compact":
    case "review":
    case "undo":
    case "goal":
      return value;
    default:
      return null;
  }
}

function noticeCommandStatus(value: unknown): NoticeCommandStatus | null {
  switch (value) {
    case "running":
    case "completed":
    case "failed":
    case "canceled":
      return value;
    default:
      return null;
  }
}

function compactTitleStatus(
  title: string | null,
  status: string | null | undefined
): NoticeCommandStatus | null {
  switch (title) {
    case "Compacting context.":
      return "running";
    case "Context compacted.":
      return "completed";
    case "Context compaction interrupted.":
      return compactStreamStatus(status) === "canceled" ? "canceled" : "failed";
    default:
      return null;
  }
}

function compactStreamStatus(
  status: string | null | undefined
): NoticeCommandStatus {
  switch (status?.trim().toLowerCase()) {
    case "completed":
    case "complete":
    case "done":
    case "success":
    case "succeeded":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "canceled":
    case "cancelled":
    case "stopped":
      return "canceled";
    default:
      return "running";
  }
}

function recordString(
  record: Record<string, unknown> | null,
  key: string
): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
