import { describe, expect, it } from "vitest";
import { isAgentRichTextImeComposing } from "./agentRichTextIme";

function keyboardEventWithFallbacks(input: {
  isComposing?: boolean;
  keyCode?: number;
  which?: number;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
    which?: number;
  };
}): KeyboardEvent {
  return input as KeyboardEvent;
}

describe("agentRichTextIme", () => {
  it("detects standard composition state", () => {
    expect(
      isAgentRichTextImeComposing(
        keyboardEventWithFallbacks({ isComposing: true })
      )
    ).toBe(true);
  });

  it("detects native event composition state", () => {
    expect(
      isAgentRichTextImeComposing(
        keyboardEventWithFallbacks({ nativeEvent: { isComposing: true } })
      )
    ).toBe(true);
  });

  it("detects Safari IME keyCode and which fallbacks", () => {
    expect(
      isAgentRichTextImeComposing(keyboardEventWithFallbacks({ keyCode: 229 }))
    ).toBe(true);
    expect(
      isAgentRichTextImeComposing(keyboardEventWithFallbacks({ which: 229 }))
    ).toBe(true);
    expect(
      isAgentRichTextImeComposing(
        keyboardEventWithFallbacks({ nativeEvent: { keyCode: 229 } })
      )
    ).toBe(true);
    expect(
      isAgentRichTextImeComposing(
        keyboardEventWithFallbacks({ nativeEvent: { which: 229 } })
      )
    ).toBe(true);
  });

  it("does not flag ordinary key events", () => {
    expect(
      isAgentRichTextImeComposing(keyboardEventWithFallbacks({ keyCode: 13 }))
    ).toBe(false);
  });
});
