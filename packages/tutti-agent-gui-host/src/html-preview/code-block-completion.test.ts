// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isClosedCodeBlock } from "./code-block-completion";

describe("original code fence completion", () => {
  it.each([
    ["```svg\n<svg/>\n```", true],
    ["~~~~svg\n<svg/>\n~~~~~  ", true],
    ["```svg\n<svg/>\n  ```", true],
    ["```svg\n<svg/>\n> ```", true],
    ["```svg\n<svg/>", false],
    ["```svg\n<svg/>\n``", false],
    ["````svg\n<svg/>\n```", false],
    ["```svg\n<svg/>\n~~~", false],
    ["```svg\n<svg/>\n```more", false],
    ["<svg/>\n```", false],
    ["```svg", false]
  ])("checks the real closing line in %j", (source, closed) => {
    expect(isClosedCodeBlock(source, {
      position: { start: { offset: 0 }, end: { offset: source.length } }
    })).toBe(closed);
  });

  it("does not mistake a stabilizer-added fence for model output", () => {
    const source = "```svg\n<svg/>";
    expect(isClosedCodeBlock(source, {
      position: { start: { offset: 0 }, end: { offset: source.length + 4 } }
    })).toBe(false);
  });

  it("uses the code node's range when several fences share one parsed block", () => {
    const first = "```svg\n<svg/>\n```";
    const source = `${first}\nMore\n\`\`\`svg\n<svg>`;
    expect(isClosedCodeBlock(source, {
      position: { start: { offset: 0 }, end: { offset: first.length } }
    })).toBe(true);
    expect(isClosedCodeBlock(source, undefined)).toBe(false);
  });
});
