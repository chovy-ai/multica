// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalLocalTimingStage, isLocalTimingModelOutput, LOCAL_TIMING_DIMENSIONS, LOCAL_TIMING_LEGACY_MAPPING, LOCAL_TIMING_LEGACY_STAGES, LOCAL_TIMING_MARKS, LOCAL_TIMING_REASONS, parseLocalTiming } from "./timing";

const contract = JSON.parse(readFileSync(join(__dirname, "../../../server/internal/localconversation/timing/testdata/contract.json"), "utf8")) as {
  legacyStages: string[]; marks: string[]; legacyMapping: Record<string, string>; dimensions: Record<string, string[]>; reasons: string[];
  records: { name: string; input: unknown; expected: unknown }[];
};
const base = { version: 2, source: "daemon", at: "2026-11-02T10:00:00.000Z", event: "mark", elapsedMs: 1 };

describe("local timing contract", () => {
  it("lists the same marks and closed enums as the Go writer's contract file", () => {
    expect([...LOCAL_TIMING_MARKS]).toEqual(contract.marks);
    expect([...LOCAL_TIMING_LEGACY_STAGES]).toEqual(contract.legacyStages);
    expect(LOCAL_TIMING_LEGACY_MAPPING).toEqual(contract.legacyMapping);
    expect(LOCAL_TIMING_DIMENSIONS).toEqual(contract.dimensions);
    expect([...LOCAL_TIMING_REASONS]).toEqual(contract.reasons);
  });

  it.each(contract.marks)("accepts the mark %s", (stage) => {
    expect(parseLocalTiming({ ...base, stage })).toMatchObject({ stage });
  });

  it.each(contract.legacyStages)("keeps the old stage %s readable", (stage) => {
    expect(parseLocalTiming({ ...base, version: 1, conversationId: "c", stage })).toMatchObject({ stage, version: 1 });
  });

  it.each(contract.records)("handles the shared sample: $name", ({ input, expected }) => {
    expect(parseLocalTiming(input)).toEqual(expected);
  });

  it("maps every old stage in the mapping onto a current mark", () => {
    for (const [legacy, current] of Object.entries(LOCAL_TIMING_LEGACY_MAPPING)) {
      expect(LOCAL_TIMING_LEGACY_STAGES as readonly string[]).toContain(legacy);
      expect(LOCAL_TIMING_MARKS as readonly string[]).toContain(current);
    }
    expect(canonicalLocalTimingStage("gui.submit")).toBe("client.request");
    expect(canonicalLocalTimingStage("provider.first_text")).toBe("provider.first_text");
    expect(canonicalLocalTimingStage("provider.tool")).toBe("provider.tool");
  });

  it("drops a non-integer count instead of the record", () => {
    expect(parseLocalTiming({ ...base, stage: "turn.persist", attempt: 1.5, turnIndex: "3" })).toEqual({ ...base, stage: "turn.persist" });
  });

  it("treats only provider items as model output", () => {
    expect(isLocalTimingModelOutput("item.delta", "reasoning")).toBe(true);
    expect(isLocalTimingModelOutput("item.started", "tool_call")).toBe(true);
    for (const [type, kind] of [["user.message", undefined], ["turn.started", undefined], ["item.completed", "error"], ["item.started", "background_task"], ["item.delta", undefined]] as const) {
      expect(isLocalTimingModelOutput(type, kind)).toBe(false);
    }
  });
});
