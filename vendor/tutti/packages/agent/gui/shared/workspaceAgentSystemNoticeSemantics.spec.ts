import { describe, expect, it } from "vitest";
import { resolveWorkspaceAgentNoticeCommandSemantics } from "./workspaceAgentSystemNoticeSemantics";

describe("resolveWorkspaceAgentNoticeCommandSemantics", () => {
  it("prefers canonical message semantics over duplicated payload fields", () => {
    expect(
      resolveWorkspaceAgentNoticeCommandSemantics({
        eventId: "notice-1",
        messageSemantics: {
          noticeCommand: "compact",
          noticeCommandStatus: "running"
        },
        payload: {
          noticeCommand: "review",
          noticeCommandStatus: "completed"
        }
      })
    ).toEqual({ command: "compact", commandStatus: "running" });
  });

  it("normalizes exact legacy compaction lifecycle records", () => {
    expect(
      resolveWorkspaceAgentNoticeCommandSemantics({
        eventId: "compaction:turn-1",
        payload: { title: "Context compacted.", source: "runtime" },
        status: "completed"
      })
    ).toEqual({ command: "compact", commandStatus: "completed" });
    expect(
      resolveWorkspaceAgentNoticeCommandSemantics({
        eventId: "legacy-compact",
        payload: { source: "compact" },
        status: "failed"
      })
    ).toEqual({ command: "compact", commandStatus: "failed" });
    expect(
      resolveWorkspaceAgentNoticeCommandSemantics({
        eventId: "compaction:turn-canceled",
        payload: { title: "Context compaction interrupted." },
        status: "canceled"
      })
    ).toEqual({ command: "compact", commandStatus: "canceled" });
  });

  it("fails open when either legacy identity or lifecycle copy is absent", () => {
    expect(
      resolveWorkspaceAgentNoticeCommandSemantics({
        eventId: "ordinary-notice",
        payload: { title: "Context compacted.", source: "runtime" },
        status: "completed"
      })
    ).toBeNull();
    expect(
      resolveWorkspaceAgentNoticeCommandSemantics({
        eventId: "compaction:turn-1",
        payload: { title: "Unrelated notice", source: "runtime" },
        status: "completed"
      })
    ).toBeNull();
  });
});
