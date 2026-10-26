import { describe, expect, it } from "vitest";
import { normalizeAgentActivitySession } from "@tutti-os/agent-activity-core";
import {
  buildWorkspaceAgentActivityListViewModel,
  reuseWorkspaceAgentActivityListViewModelIfUnchanged
} from "./activity-list-projection.ts";

describe("activity-list-projection public contract", () => {
  it("projects canonical status and combines current and historical Turn files", () => {
    const session = normalizeAgentActivitySession({
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      activeTurnId: null,
      cwd: "/workspace/project",
      latestTurn: {
        agentSessionId: "session-1",
        fileChanges: {
          files: [{ change: "added", path: "reports/current.md" }]
        },
        origin: "user_prompt",
        outcome: "completed",
        phase: "settled",
        settledAtUnixMs: 300,
        startedAtUnixMs: 200,
        turnId: "turn-2",
        updatedAtUnixMs: 300
      },
      latestTurnInteractions: [],
      pendingInteractions: [],
      provider: "codex",
      providerSessionId: "provider-session-1",
      title: "Prepare report",
      userId: "user-1"
    });

    const view = buildWorkspaceAgentActivityListViewModel(
      {
        presences: [],
        sessions: [session]
      },
      {
        sessionTurnFileChangesById: {
          "provider-session-1": [
            {
              files: [
                { change: "modified", path: "archive/summary.md" },
                { change: "modified", path: "archive/current.md" }
              ]
            },
            { coverage: "none" }
          ]
        }
      }
    );

    expect(view.activities).toHaveLength(1);
    expect(view.activities[0]).toMatchObject({
      sessionId: "session-1",
      status: "completed",
      title: "Prepare report",
      changedFiles: [
        { label: "summary.md", path: "archive/summary.md" },
        { label: "archive/current.md", path: "archive/current.md" },
        { label: "reports/current.md", path: "reports/current.md" }
      ]
    });
  });

  it("keeps the public reference-reuse contract", () => {
    const view = { activities: [] };
    expect(
      reuseWorkspaceAgentActivityListViewModelIfUnchanged(view, view)
    ).toBe(view);
  });
});
