export interface WorkspaceAgentSessionSortTimeSession {
  createdAtUnixMs?: number;
  latestTurn?: WorkspaceAgentSessionSortTimeTurn | null;
}

export interface WorkspaceAgentSessionSortTimeTurn {
  startedAtUnixMs: number;
}

export function resolveWorkspaceAgentSessionSortTimeUnixMs(
  session: WorkspaceAgentSessionSortTimeSession
): number {
  return (
    positiveNumber(session.latestTurn?.startedAtUnixMs) ??
    positiveNumber(session.createdAtUnixMs) ??
    0
  );
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}
