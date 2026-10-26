import { describe, expect, it } from "vitest";
import { resolveWorkspaceAgentSessionSortTimeUnixMs } from "./workspaceAgentSessionSortTime";

describe("resolveWorkspaceAgentSessionSortTimeUnixMs", () => {
  it("uses the canonical latest turn start", () => {
    const sortTime = resolveWorkspaceAgentSessionSortTimeUnixMs({
      createdAtUnixMs: 100,
      latestTurn: { startedAtUnixMs: 250 }
    });

    expect(sortTime).toBe(250);
  });

  it("falls back to session creation time when there is no user message", () => {
    const session = {
      agentSessionId: "session-1",
      createdAtUnixMs: 400,
      endedAtUnixMs: 9_000,
      latestTurn: null,
      startedAtUnixMs: 500,
      updatedAtUnixMs: 8_000
    };

    expect(resolveWorkspaceAgentSessionSortTimeUnixMs(session)).toBe(400);
  });

  it("falls back to session creation time before messages are loaded", () => {
    const session = { createdAtUnixMs: 600, updatedAtUnixMs: 9_000 };
    expect(resolveWorkspaceAgentSessionSortTimeUnixMs(session)).toBe(600);
  });
});
