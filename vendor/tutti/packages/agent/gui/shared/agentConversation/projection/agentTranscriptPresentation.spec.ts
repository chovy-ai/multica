import { describe, expect, it } from "vitest";
import { resolveAgentTranscriptPresentationKind } from "./agentTranscriptPresentation";

describe("resolveAgentTranscriptPresentationKind", () => {
  it.each([
    ["running", "specific-progress"],
    ["completed", "turn-boundary"],
    ["failed", "turn-boundary"],
    ["canceled", "turn-boundary"]
  ] as const)("maps compact %s to %s", (commandStatus, expected) => {
    expect(
      resolveAgentTranscriptPresentationKind({
        command: "compact",
        commandStatus
      })
    ).toBe(expected);
  });

  it("fails open for unrelated or incomplete notice semantics", () => {
    expect(
      resolveAgentTranscriptPresentationKind({
        command: "review",
        commandStatus: "running"
      })
    ).toBe("content");
    expect(
      resolveAgentTranscriptPresentationKind({
        command: "compact",
        commandStatus: null
      })
    ).toBe("content");
    expect(resolveAgentTranscriptPresentationKind(null)).toBe("content");
  });
});
