import {
  selectSessionActivationPresentations,
  sessionActivationPresentationMapsEqual,
  type PendingActivationIntentRecord,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import { useCallback, useMemo, useRef } from "react";
import { type AppErrorCode } from "../../../shared/contracts/dto";
import { useEngineSelector } from "../../../shared/engine/useEngineSelector";

type AgentGUILiveState = "inactive" | "activating" | "active" | "failed";

type AgentGUIActivateInput = Parameters<
  AgentSessionEngine["activateSession"]
>[0] extends infer TInput
  ? TInput extends { requestId: string }
    ? Omit<TInput, "requestId">
    : never
  : never;

interface UseAgentGUIActivationInput {
  engine: AgentSessionEngine;
  workspaceId: string;
  getErrorMessage: (error: unknown) => string;
  getErrorCode?: (error: unknown) => AppErrorCode | null;
}

export function isPendingNewConversationActivation(
  activation:
    | Pick<PendingActivationIntentRecord, "mode" | "status">
    | null
    | undefined
): boolean {
  return (
    activation?.mode === "new" &&
    (activation.status === "requested" || activation.status === "uncertain")
  );
}

export function isPendingNewConversationActivationForSession(
  activation:
    | Pick<PendingActivationIntentRecord, "agentSessionId" | "mode" | "status">
    | null
    | undefined,
  agentSessionId: string | null | undefined
): boolean {
  const normalizedSessionId = agentSessionId?.trim() ?? "";
  return Boolean(
    normalizedSessionId &&
    activation?.agentSessionId.trim() === normalizedSessionId &&
    isPendingNewConversationActivation(activation)
  );
}

export function useAgentGUIActivation({
  engine,
  workspaceId,
  getErrorMessage,
  getErrorCode
}: UseAgentGUIActivationInput) {
  const requestSequenceRef = useRef(0);
  const presentations = useEngineSelector(
    engine,
    selectSessionActivationPresentations,
    sessionActivationPresentationMapsEqual
  );

  const nextRequestId = (kind: string, agentSessionId: string): string => {
    requestSequenceRef.current += 1;
    return `${kind}:${workspaceId}:${agentSessionId}:${Date.now()}:${requestSequenceRef.current}`;
  };

  const activate = useCallback(
    (input: AgentGUIActivateInput): string | null => {
      const agentSessionId = input.agentSessionId.trim();
      const requestId = nextRequestId("activation", agentSessionId);
      return engine.activateSession({
        ...input,
        agentSessionId,
        requestId
      })
        ? requestId
        : null;
    },
    [engine, workspaceId]
  );

  const unactivate = useCallback(
    (agentSessionId: string): Promise<void> => {
      const normalized = agentSessionId.trim();
      if (!normalized) {
        return Promise.resolve();
      }
      engine.dispatch({
        type: "activation/unactivateRequested",
        agentSessionId: normalized,
        commandId: nextRequestId("unactivate", normalized),
        workspaceId
      });
      return Promise.resolve();
    },
    [engine, workspaceId]
  );

  const markFailed = useCallback(
    (agentSessionId: string, error: unknown): void => {
      const normalized = agentSessionId.trim();
      if (!normalized) {
        return;
      }
      engine.dispatch({
        type: "activation/failureRecorded",
        agentSessionId: normalized,
        errorCode: getErrorCode?.(error) ?? null,
        errorMessage: getErrorMessage(error),
        occurredAtUnixMs: Date.now(),
        requestId: nextRequestId("activation-failure", normalized),
        workspaceId
      });
    },
    [engine, getErrorCode, getErrorMessage, workspaceId]
  );

  const clearFailure = useCallback(
    (agentSessionId: string): void => {
      const normalized = agentSessionId.trim();
      if (normalized) {
        engine.dispatch({
          type: "activation/failureCleared",
          agentSessionId: normalized
        });
      }
    },
    [engine]
  );

  const stateFor = useCallback(
    (agentSessionId: string | null | undefined): AgentGUILiveState =>
      (agentSessionId ? presentations[agentSessionId]?.status : null) ??
      "inactive",
    [presentations]
  );
  const errorFor = useCallback(
    (agentSessionId: string | null | undefined): string | null =>
      (agentSessionId ? presentations[agentSessionId]?.errorMessage : null) ??
      null,
    [presentations]
  );
  const codeFor = useCallback(
    (agentSessionId: string | null | undefined): AppErrorCode | null =>
      ((agentSessionId
        ? presentations[agentSessionId]?.errorCode
        : null) as AppErrorCode | null) ?? null,
    [presentations]
  );

  return useMemo(
    () => ({
      activate,
      clearFailure,
      markFailed,
      unactivate,
      stateFor,
      errorFor,
      codeFor
    }),
    [
      activate,
      clearFailure,
      codeFor,
      errorFor,
      markFailed,
      stateFor,
      unactivate
    ]
  );
}
