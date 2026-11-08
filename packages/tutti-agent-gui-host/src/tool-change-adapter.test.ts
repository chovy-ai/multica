// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { toolChangeAdapter } from "../tool-change-adapter";

it("adds the Desktop action to the pinned tool card and fails visibly when its anchor changes", () => {
  const plugin = toolChangeAdapter();
  const transform = plugin.transform as (code: string, id: string) => { code: string } | undefined;
  const id = "agentConversation/components/AgentToolCallCard.tsx";
  const source = readFileSync(new URL("../../../vendor/tutti/packages/agent/gui/shared/" + id, import.meta.url), "utf8");
  expect(transform(source, "/" + id)?.code).toContain("<FileChangeAction call={call} />");
  expect(transform(source, "/unrelated.tsx")).toBeUndefined();
  expect(() => transform("changed card", "/" + id)).toThrow("anchor changed");
});
