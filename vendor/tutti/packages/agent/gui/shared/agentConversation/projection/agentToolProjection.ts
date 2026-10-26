import type { WorkspaceAgentSessionDetailToolCall } from "../../workspaceAgentSessionDetailViewModel";
import { extractAgentMcpToolTarget } from "../../agentMcpToolTarget";
import type { AgentToolCallVM } from "../contracts/agentToolCallVM";
import { projectAgentApprovalItem } from "./agentApprovalProjection";
import {
  projectAgentAskUserQuestionItem,
  projectAgentPlanModeItem
} from "./agentInteractiveProjection";
import { projectAgentTaskItem } from "./agentTaskProjection";
import { resolveAgentToolRendererKind } from "./agentToolRendererKind";

export function projectAgentToolCall(
  call: WorkspaceAgentSessionDetailToolCall
): AgentToolCallVM {
  const input = objectValue(call.payload?.input);
  const output = objectValue(call.payload?.output);
  const error = objectValue(call.payload?.error);
  const metadata = objectValue(call.payload?.metadata);
  const locations = arrayValue(call.payload?.locations);
  const approval = projectAgentApprovalItem(call, input, output);
  const askUserQuestion = projectAgentAskUserQuestionItem(call, input, output);
  const planMode = projectAgentPlanModeItem(call, input);
  const task = projectAgentTaskItem(call, input, output, metadata);
  const mcpTarget = extractAgentMcpToolTarget({
    input,
    metadata,
    payload: call.payload,
    toolName: call.toolName,
    name: call.name
  });
  const rendererKind = resolveAgentToolRendererKind(
    {
      toolName: call.toolName,
      displayName: call.name,
      callType: call.callType,
      input,
      output,
      metadata
    },
    approval,
    askUserQuestion,
    planMode,
    task
  );
  const projectedCall: AgentToolCallVM = {
    kind: "tool-call",
    ...call,
    turnId: call.turnId ?? "turn:unknown",
    name: mcpTarget?.displayName ?? call.name,
    compactSummary: call.compactSummary ?? call.summary,
    payload: call.payload ?? null,
    input,
    output,
    error,
    metadata,
    locations,
    rendererKind,
    approval,
    askUserQuestion,
    planMode,
    task,
    occurredAtUnixMs: call.occurredAtUnixMs ?? null
  };
  if (call.sourceTimelineItems) {
    projectedCall.sourceTimelineItems = call.sourceTimelineItems;
  }
  return projectedCall;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}
