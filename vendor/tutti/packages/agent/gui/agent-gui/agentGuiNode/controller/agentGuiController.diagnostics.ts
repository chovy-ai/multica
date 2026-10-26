import type {
  AgentActivityTurn,
  CanonicalAgentSession
} from "@tutti-os/agent-activity-core";
import type { AgentConversationVM } from "../../../shared/agentConversation/contracts/agentConversationVM";
import type { AgentSessionState } from "../../../shared/agentSessionTypes";

export function promptRequestId(
  prompt: { requestId?: string | null } | null | undefined
): string | null {
  const requestId = prompt?.requestId?.trim() ?? "";
  return requestId || null;
}

export function agentGUIConversationDiagnosticDetails(
  conversation: AgentConversationVM | null
): Record<string, unknown> | null {
  if (!conversation) return null;
  const processingRows = conversation.rows.filter(
    (row) => row.kind === "processing"
  );
  const toolCalls = conversation.rows.flatMap((row) =>
    row.kind === "tool-group" ? row.calls : []
  );
  const waitingToolCalls = toolCalls.filter((call) =>
    agentGUIToolCallStatusIsWaiting(call.status)
  );
  return {
    activityStatus: conversation.activity.status,
    showProcessingIndicator:
      conversation.sourceDetail.showProcessingIndicator === true,
    processingRowCount: processingRows.length,
    processingTurnIds: processingRows
      .map((row) => row.turnId)
      .filter((turnId): turnId is string => Boolean(turnId)),
    rowCount: conversation.rows.length,
    sourceActiveTurn: agentGUIActivityTurnDiagnosticDetails(
      conversation.sourceDetail.session.activeTurn
    ),
    sourceActiveTurnId: conversation.sourceDetail.session.activeTurnId ?? null,
    sourceLatestTurn: agentGUIActivityTurnDiagnosticDetails(
      conversation.sourceDetail.session.latestTurn
    ),
    sourceSessionTurnCount: conversation.sourceDetail.sessionTurns?.length ?? 0,
    sourceSessionTurnTail:
      conversation.sourceDetail.sessionTurns
        ?.slice(-3)
        .map(agentGUIActivityTurnDiagnosticDetails) ?? [],
    toolCallCount: toolCalls.length,
    turnCount: conversation.sourceDetail.turns.length,
    waitingToolCallCount: waitingToolCalls.length,
    waitingToolCalls: waitingToolCalls.slice(-5).map((call) => ({
      callType: call.callType,
      id: call.id,
      name: call.name,
      rendererKind: call.rendererKind,
      status: call.status,
      statusKind: call.statusKind,
      toolName: call.toolName,
      turnId: call.turnId
    }))
  };
}

export function agentGUIActivityTurnDiagnosticDetails(
  turn: AgentActivityTurn | null | undefined
): Record<string, unknown> | null {
  if (!turn) return null;
  return {
    outcome: turn.outcome ?? null,
    phase: turn.phase,
    settledAtUnixMs: turn.settledAtUnixMs ?? null,
    turnId: turn.turnId,
    updatedAtUnixMs: turn.updatedAtUnixMs
  };
}

export function agentGUIToolCallStatusIsWaiting(
  status: string | null
): boolean {
  return [
    "waiting",
    "waiting_approval",
    "pending",
    "in_progress",
    "running"
  ].includes(status ?? "");
}

export function agentGUIRuntimeSessionDiagnosticDetails(
  session: CanonicalAgentSession | null
): Record<string, unknown> | null {
  if (!session) return null;
  return {
    activeTurnId: session.activeTurnId ?? null,
    agentSessionId: session.agentSessionId,
    provider: session.provider,
    updatedAtUnixMs: session.updatedAtUnixMs ?? null
  };
}

export function agentGUISessionStateDiagnosticDetails(
  state: AgentSessionState | null
): Record<string, unknown> | null {
  if (!state) return null;
  return {
    authState: state.authState?.trim() || null,
    provider: state.provider,
    resumable: state.resumable ?? null,
    updatedAtUnixMs: state.updatedAtUnixMs ?? null
  };
}
