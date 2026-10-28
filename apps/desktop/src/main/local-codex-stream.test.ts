// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { CodexTurnStream } from "./local-codex-stream";

describe("Codex app-server message boundaries", () => {
  it("separates complete messages around tools and deduplicates completed items", () => {
    const emit = vi.fn();
    const stream = new CodexTurnStream(emit);
    const complete = (id: string, text: string) => stream.accept("item/completed", { item: { id, type: "agentMessage", text } });
    complete("progress", "先检查模块。");
    stream.accept("item/started", { item: { id: "tool", type: "commandExecution", command: "pwd" } });
    stream.accept("item/completed", { item: { id: "tool", type: "commandExecution", aggregatedOutput: "/fixture" } });
    complete("next", "接下来验证类型。");
    const final = "已改好：\n\n- 模块管理\n\n[PR](https://example.com/pr)";
    complete("final", final);
    complete("final", final);
    const expected = `先检查模块。\n\n接下来验证类型。\n\n${final}`;
    expect(stream.parser.output).toBe(expected);
    expect(emit.mock.calls.map(([event]) => event).filter((event) => event.type === "text").map((event) => event.content).join("")).toBe(expected);
    expect(emit).toHaveBeenCalledWith({ type: "tool_result", tool: "Bash", call_id: "tool", output: "/fixture" });
  });

  it.each(["", "\n", "\n\n"])("keeps deltas contiguous and matches completed text after %j", (ending) => {
    const emit = vi.fn();
    const stream = new CodexTurnStream(emit);
    const complete = (id: string, text: string) => stream.accept("item/completed", { item: { id, type: "agentMessage", text } });
    const delta = (itemId: string, text: string) => stream.accept("item/agentMessage/delta", { itemId, delta: text });
    delta("progress", "先检查");
    delta("progress", "模块。");
    complete("progress", `先检查模块。${ending}`);
    delta("empty", "");
    complete("empty", "");
    delta("final", "");
    delta("final", "已改");
    delta("final", "好：\n\n```ts\n");
    const final = "已改好：\n\n```ts\nconst ready = true;\n```";
    complete("final", final);
    complete("final", final);
    delta("final", "late duplicate");
    const expected = `先检查模块。\n\n${final}`;
    expect(stream.parser.output).toBe(expected);
    expect(emit.mock.calls.map(([event]) => event.content).join("")).toBe(expected);
  });
});
