import { describe, expect, it } from "vitest";
import { installReactRenderLoopConsoleTrap } from "./reactRenderLoopConsoleTrap";

describe("installReactRenderLoopConsoleTrap", () => {
  it("passes through unrelated console errors", () => {
    const calls: unknown[][] = [];
    const testConsole = {
      error: (...args: unknown[]) => calls.push(args)
    };
    const restore = installReactRenderLoopConsoleTrap({
      console: testConsole
    });

    testConsole.error("ordinary app error");
    restore();

    expect(calls).toEqual([["ordinary app error"]]);
  });

  it("throws when React reports a render loop", () => {
    const calls: unknown[][] = [];
    const testConsole = {
      error: (...args: unknown[]) => calls.push(args)
    };
    const restore = installReactRenderLoopConsoleTrap({
      console: testConsole
    });

    expect(() =>
      testConsole.error("Warning: Maximum update depth exceeded.")
    ).toThrow(/React render loop detected/u);
    restore();

    expect(calls).toEqual([["Warning: Maximum update depth exceeded."]]);
  });
});
