// @vitest-environment node
import { describe, expect, it } from "vitest";
import { shouldStagePastedText } from "./large-text-paste";

describe("large pasted text admission", () => {
  it.each(["\n", "\r\n", "\r"])("folds more than 1000 short lines separated by %j", (separator) => {
    expect(shouldStagePastedText(Array(1000).fill("x").join(separator))).toBe(false);
    expect(shouldStagePastedText(Array(1001).fill("x").join(separator))).toBe(true);
  });
  it("keeps the upstream character threshold for long single-line pastes", () => {
    expect(shouldStagePastedText("x".repeat(4999))).toBe(false);
    expect(shouldStagePastedText("x".repeat(5000))).toBe(true);
    expect(shouldStagePastedText("x".repeat(5000), 6000)).toBe(false);
  });
  it("counts blank lines and mixed line endings without rewriting the pasted text", () => {
    const text = `first\r\n${"\n".repeat(998)}last`;
    expect(shouldStagePastedText(text)).toBe(false);
    expect(shouldStagePastedText(`${text}\rfinal`)).toBe(true);
  });
  it("does not consume whitespace-only clipboard content as an empty attachment", () => {
    expect(shouldStagePastedText(" \r\n\t".repeat(1001))).toBe(false);
  });
});
