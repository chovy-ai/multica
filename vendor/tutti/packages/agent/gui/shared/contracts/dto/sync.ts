export interface GetSyncStateResult {
  revision: number;
  state: unknown | null;
}

export type SyncEventPayload =
  | {
      type: "app_state.updated";
      revision: number;
      operationId: string;
    }
  | {
      type: "resync_required";
      revision: number;
    };

export interface WriteSyncStateInput {
  state: unknown;
  baseRevision?: number | null;
}

export interface WriteSyncStateResult {
  revision: number;
}
