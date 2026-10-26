import type { AgentMessageContentVM } from "../contracts/agentMessageRowVM";
import type { AgentTranscriptPresentationKind } from "../contracts/agentTranscriptPresentation";
import type { AgentTranscriptRowVM } from "../contracts/agentTranscriptRowVM";

type AgentSystemNoticeVM = NonNullable<AgentMessageContentVM["systemNotice"]>;

export function resolveAgentTranscriptPresentationKind(
  notice: Pick<AgentSystemNoticeVM, "command" | "commandStatus"> | null
): AgentTranscriptPresentationKind {
  if (notice?.command !== "compact") {
    return "content";
  }
  if (notice.commandStatus === "running") {
    return "specific-progress";
  }
  if (
    notice.commandStatus === "completed" ||
    notice.commandStatus === "failed" ||
    notice.commandStatus === "canceled"
  ) {
    return "turn-boundary";
  }
  return "content";
}

export function agentTranscriptRowHasPresentationKind(
  row: AgentTranscriptRowVM | undefined,
  presentationKind: AgentTranscriptPresentationKind
): boolean {
  return Boolean(
    row?.kind === "message" &&
    row.messages.some(
      (message) => message.presentationKind === presentationKind
    )
  );
}
