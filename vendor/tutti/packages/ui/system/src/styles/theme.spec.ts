import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const themeCss = readFileSync("src/styles/theme.css", "utf8");

function zIndexToken(name: string): number {
  const match = themeCss.match(new RegExp(`--${name}:\\s*(\\d+);`));
  if (!match?.[1]) {
    throw new Error(`Missing z-index token: --${name}`);
  }
  return Number(match[1]);
}

describe("global overlay layers", () => {
  it("keeps toast notifications above dialogs and below tooltips", () => {
    expect(zIndexToken("z-toast")).toBeGreaterThan(
      zIndexToken("z-dialog-popover")
    );
    expect(zIndexToken("z-toast")).toBeLessThan(zIndexToken("z-tooltip"));
  });
});
