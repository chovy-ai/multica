import { describe, expect, it } from "vitest";
import {
  latestPlanTurnId,
  planImplementationPromptFromPlanTurn
} from "./planImplementationPresentation";

describe("plan implementation presentation", () => {
  it("projects a plan implementation prompt", () => {
    expect(
      planImplementationPromptFromPlanTurn("turn-1", "Implement?")
    ).toEqual({
      kind: "plan-implementation",
      requestId: "turn-1",
      title: "Implement?"
    });
  });

  it("returns the latest turn only when it contains a plan item", () => {
    expect(
      latestPlanTurnId([
        {
          turnId: "turn-1",
          occurredAtUnixMs: 1,
          payload: { messageKind: "plan" }
        },
        {
          turnId: "turn-2",
          occurredAtUnixMs: 2,
          payload: { messageKind: "text" }
        }
      ])
    ).toBeNull();
    expect(
      latestPlanTurnId([
        {
          turnId: "turn-1",
          occurredAtUnixMs: 1,
          payload: { messageKind: "text" }
        },
        {
          turnId: "turn-2",
          occurredAtUnixMs: 2,
          payload: { messageKind: "plan" }
        }
      ])
    ).toBe("turn-2");
  });
});
