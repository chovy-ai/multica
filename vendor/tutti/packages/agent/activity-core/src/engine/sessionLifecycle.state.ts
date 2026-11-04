import { createInitialSettingsUpdate } from "./sessionSettings.reducer.ts";
import type {
  SessionLifecycleState,
  SessionOperationState
} from "./sessionLifecycle.types.ts";

export function initialOperation(): SessionOperationState {
  return {
    runtimeAvailability: { state: "available" },
    runtimeActivity: "idle",
    runtimeActivityOccurredAtUnixMs: 0,
    operationError: null,
    settingsUpdate: createInitialSettingsUpdate()
  };
}

export function setOperation(
  state: SessionLifecycleState,
  id: string,
  operation: SessionOperationState
): SessionLifecycleState {
  return {
    ...state,
    operationBySessionId: { ...state.operationBySessionId, [id]: operation }
  };
}
