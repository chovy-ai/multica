import type { AppErrorDescriptor } from "./error";

export type PersistWriteLevel = "full" | "no_scrollback" | "settings_only";

export type PersistWriteFailureReason =
  | "unavailable"
  | "quota"
  | "payload_too_large"
  | "io"
  | "unknown";

export type PersistWriteResult =
  | {
      ok: true;
      level: PersistWriteLevel;
      bytes: number;
      revision?: number;
    }
  | {
      ok: false;
      reason: PersistWriteFailureReason;
      error: AppErrorDescriptor;
    };

export interface WriteWorkspaceStateRawInput {
  raw: string;
}

export type PersistenceRecoveryReason = "corrupt_db" | "migration_failed";

export interface ReadAppStateResult {
  state: unknown | null;
  recovery: PersistenceRecoveryReason | null;
}

export interface WriteAppStateInput {
  state: unknown;
}

export interface ReadRoomCanvasStateInput {
  roomId: string;
  userId: string;
}

export interface WriteRoomCanvasStateInput {
  roomId: string;
  userId: string;
  raw: string | null;
}

export type WorkspaceAgentReadStateKind = "completed" | "failed";

export interface WorkspaceAgentReadStateBucket {
  readIds: string[];
  unreadIds: string[];
}

export interface WorkspaceAgentReadStateSnapshot {
  completed: WorkspaceAgentReadStateBucket;
  failed: WorkspaceAgentReadStateBucket;
}

export interface ReadWorkspaceAgentReadStateInput {
  roomId: string;
  userId: string;
}

export interface WriteWorkspaceAgentReadStateInput extends ReadWorkspaceAgentReadStateInput {
  kind: WorkspaceAgentReadStateKind;
  readIds: string[];
  unreadIds: string[];
}

export interface ReadNodeScrollbackInput {
  nodeId: string;
}

export interface WriteNodeScrollbackInput {
  nodeId: string;
  scrollback: string | null;
}

export interface ReadAgentNodePlaceholderScrollbackInput {
  nodeId: string;
}

export interface WriteAgentNodePlaceholderScrollbackInput {
  nodeId: string;
  scrollback: string | null;
}
