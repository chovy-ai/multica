import { describe, expect, it } from "vitest";
import {
  createAgentSessionEngine,
  type EngineCommand
} from "@tutti-os/agent-activity-core";
import { createTestEngineCommandPort } from "../testing/createTestAgentSessionEngine";
import { dispatchAgentPlanPromptAction } from "./agentPlanPromptDispatch";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("dispatchAgentPlanPromptAction", () => {
  it.each([
    ["implement", "plan/submitDecision"],
    ["feedback", "queue/sendPrompt"],
    ["skip", null]
  ] as const)(
    "dispatches %s against a settled completed plan turn",
    async (action, commandType) => {
      const executed: EngineCommand[] = [];
      const engine = createAgentSessionEngine({
        clock: { nowUnixMs: () => 10 },
        commandPort: createTestEngineCommandPort({
          async executePlanDecision(command) {
            executed.push(command);
            return {
              operation: {
                agentSessionId: command.agentSessionId,
                idempotencyKey: command.idempotencyKey,
                operationId: `operation:${command.commandId}`,
                requestId: command.requestId,
                status: "prepared",
                turnId: command.turnId,
                workspaceId: command.workspaceId
              }
            };
          },
          async execute(command) {
            executed.push(command);
          }
        }),
        identity: { origin: "test", workspaceId: "workspace-1" },
        scheduler: { schedule: () => ({ cancel() {} }) }
      });
      engine.dispatch({
        type: "session/snapshotReceived",
        sessions: [
          {
            ...{
              activeTurnId: null,
              latestTurnInteractions: [],
              pendingInteractions: []
            },
            workspaceId: "workspace-1",
            agentSessionId: "session-1",
            provider: "codex",
            cwd: "/workspace",
            title: "Plan",
            activeTurnId: null,
            latestTurn: {
              agentSessionId: "session-1",
              turnId: "turn-1",
              origin: "user_prompt",
              phase: "settled",
              outcome: "completed",
              startedAtUnixMs: 1,
              updatedAtUnixMs: 2,
              settledAtUnixMs: 2
            }
          }
        ]
      });

      expect(
        dispatchAgentPlanPromptAction({
          action,
          agentSessionId: "session-1",
          engine,
          feedbackText: action === "feedback" ? "Revise it" : undefined,
          nowUnixMs: () => 20,
          requestId: "turn-1",
          workspaceId: "workspace-1"
        })
      ).toBe(true);
      await Promise.resolve();
      expect(executed[0]?.type ?? null).toBe(commandType);
      if (executed[0]?.type === "queue/sendPrompt") {
        expect(executed[0].clientSubmitId).toMatch(UUID_V4_PATTERN);
      }
    }
  );

  it("rejects a request id that is not the latest settled completed turn", () => {
    const engine = createAgentSessionEngine({
      clock: { nowUnixMs: () => 1 },
      commandPort: createTestEngineCommandPort({
        execute: async () => undefined
      }),
      identity: { origin: "test", workspaceId: "workspace-1" },
      scheduler: { schedule: () => ({ cancel() {} }) }
    });
    expect(
      dispatchAgentPlanPromptAction({
        action: "implement",
        agentSessionId: "session-1",
        engine,
        requestId: "turn-1",
        workspaceId: "workspace-1"
      })
    ).toBe(false);
  });

});
