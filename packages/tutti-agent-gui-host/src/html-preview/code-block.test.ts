// @vitest-environment node
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { codeBlockPreview } from "./code-block";

describe("document preview code block selection", () => {
  it("recognizes explicit HTML fences without altering their code", () => {
    for (const language of ["html", "htm", "HTML"]) {
      expect(codeBlockPreview(createElement("code", { className: `extra language-${language}` }, '<button onclick="run()">Try</button>\n'))).toEqual({ source: '<button onclick="run()">Try</button>', format: "html" });
    }
  });
  it("keeps ordinary code, unlabelled blocks and multiple elements in the existing renderer", () => {
    expect(codeBlockPreview(createElement("code", { className: "language-js" }, "const html = '<p>Example</p>'"))).toBeNull();
    expect(codeBlockPreview(createElement("code", {}, "<p>Example</p>"))).toBeNull();
    expect(codeBlockPreview([createElement("code", { key: "a", className: "language-html" }, "A"), createElement("code", { key: "b" }, "B")])).toBeNull();
  });
  it("selects standalone SVG fences while preserving XML, definitions and whitespace", () => {
    const source = '<?xml version="1.0"?><svg viewBox="0 0 20 20"><defs><circle id="node" r="5"/></defs><use href="#node"/></svg>\n';
    for (const language of ["svg", "SVG"]) expect(codeBlockPreview(createElement("code", { className: `language-${language}` }, source))).toEqual({ source: source.slice(0, -1), format: "svg" });
  });
});
