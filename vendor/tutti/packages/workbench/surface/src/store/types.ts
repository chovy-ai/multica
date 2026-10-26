import type { WorkbenchAction } from "../core/actions.ts";
import type { WorkbenchState } from "../core/types.ts";
import type { WorkbenchCommands } from "./commands.ts";

export type WorkbenchListener = () => void;
export type WorkbenchUnsubscribe = () => void;

export interface WorkbenchDebugDiagnostics {
  isEnabled(): boolean;
  log?(input: {
    details?: Record<string, unknown>;
    event: string;
    level?: "debug" | "info" | "warn" | "error";
    source: string;
    workspaceId?: string | null;
  }): Promise<void> | void;
}

export interface WorkbenchStore<TData = unknown> {
  getSnapshot(): WorkbenchState<TData>;
  subscribe(listener: WorkbenchListener): WorkbenchUnsubscribe;
  dispatch(action: WorkbenchAction<TData>): void;
}

export interface WorkbenchController<
  TData = unknown
> extends WorkbenchStore<TData> {
  readonly commands: WorkbenchCommands<TData>;
}
