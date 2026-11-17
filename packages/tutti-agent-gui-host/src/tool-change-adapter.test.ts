// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { toolChangeAdapter } from "../tool-change-adapter";

it("leaves the tool card alone and adds evidence to expanded tool content", () => {
  const plugin = toolChangeAdapter();
  const transform = plugin.transform as (code: string, id: string) => { code: string } | undefined;
  const id = "agentConversation/components/AgentToolCallCard.tsx";
  const source = readFileSync(new URL("../../../vendor/tutti/packages/agent/gui/shared/" + id, import.meta.url), "utf8");
  expect(transform(source, "/" + id)).toBeUndefined();
  expect(transform(source, "/unrelated.tsx")).toBeUndefined();
  const expanded = "agentConversation/components/tool-renderers/AgentExpandedToolContent.tsx";
  const expandedSource = readFileSync(new URL("../../../vendor/tutti/packages/agent/gui/shared/" + expanded, import.meta.url), "utf8");
  expect(transform(expandedSource, "/" + expanded)?.code).toContain("<ToolResultEvidence call={call} />");
  expect(() => transform("changed tool content", "/" + expanded)).toThrow("evidence anchor changed");
});
