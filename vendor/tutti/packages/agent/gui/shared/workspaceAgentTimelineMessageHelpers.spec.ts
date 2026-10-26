import { describe, expect, it } from "vitest";
import { messageBody } from "./workspaceAgentTimelineMessageHelpers";
import type { WorkspaceAgentActivityTimelineItem } from "./workspaceAgentTimelineTypes";

describe("messageBody", () => {
  it.each([
    ["payload content", { payload: { content: "\nHello\n" } }],
    ["top-level content", { content: "\nHello\n" }],
    ["payload text", { payload: { text: "\nHello\n" } }]
  ])("preserves whitespace from %s", (_label, fields) => {
    expect(messageBody(item(fields))).toBe("\nHello\n");
  });

  it("uses trimming only to reject whitespace-only content", () => {
    expect(
      messageBody(
        item({
          content: "fallback",
          payload: { content: " \n\t", text: "unused" }
        })
      )
    ).toBe("fallback");
    expect(messageBody(item({ payload: { text: " \n\t" } }))).toBe("");
  });

  it("still suppresses synthetic control messages surrounded by whitespace", () => {
    expect(
      messageBody(
        item({ payload: { content: "\n[Request interrupted by user]\n" } })
      )
    ).toBe("");
  });
});

function item(
  fields: Partial<WorkspaceAgentActivityTimelineItem>
): WorkspaceAgentActivityTimelineItem {
  return {
    actorId: "agent",
    actorType: "agent",
    agentSessionId: "session-1",
    eventId: "event-1",
    id: 1,
    itemType: "message",
    ...fields
  };
}
