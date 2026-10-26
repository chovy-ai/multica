// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createHtmlPreviewDocument } from "./document";
import { HTML_PREVIEW_MAX_LENGTH } from "../html-preview-contract";

describe("isolated HTML preview document", () => {
  it("applies the host policy and bundled libraries before any generated HTML", () => {
    const generated = '<main>Chart</main><script>new Chart(); d3.select("main");</script>';
    const result = createHtmlPreviewDocument(generated, { chart: "window.Chart = {};", d3: "window.d3 = {};" }, "channel", "dark", { foreground: "CanvasText" });
    expect(result.indexOf('http-equiv="Content-Security-Policy"')).toBeLessThan(result.indexOf("window.Chart"));
    expect(result.indexOf("window.Chart")).toBeLessThan(result.indexOf(generated));
    expect(result).toContain("connect-src 'none'; frame-src 'none'");
    expect(result).toContain("form-action 'none'");
    expect(result).toContain("color-scheme:dark;--foreground:CanvasText");
    expect(result).toContain('const channel = "channel"');
  });
  it("does not let library text terminate its script element", () => {
    const result = createHtmlPreviewDocument("<p>Test</p>", { chart: 'const text = "</script><script>unexpected</script>";', d3: "" }, "test", "light", {});
    expect(result).not.toContain('const text = "</script>');
    expect(result).toContain('const text = "<\\/script>');
  });
  it("rejects an oversized artifact before constructing its runnable document", () => {
    expect(() => createHtmlPreviewDocument("x".repeat(HTML_PREVIEW_MAX_LENGTH + 1), { chart: "", d3: "" }, "id", "light", {})).toThrow("too large");
  });
});
