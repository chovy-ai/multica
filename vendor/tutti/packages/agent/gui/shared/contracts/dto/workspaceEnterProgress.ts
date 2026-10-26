export type WorkspaceEnterProgressPhase =
  | "enter_started"
  | "prepare_sandbox"
  | "prepare_toolchain"
  | "ensure_runtime"
  | "run_template_hook"
  | "pre_attach_toolchain"
  | "attach_runtime"
  | "apply_projections"
  | "apply_config_overlays"
  | "sync_workspace_patch"
  | "enter_succeeded"
  | "enter_failed";

export interface WorkspaceEnterProgressEvent {
  operationId: string;
  roomId: string;
  phase: WorkspaceEnterProgressPhase;
  message: string;
  elapsedMs?: number;
}
