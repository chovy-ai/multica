// @vitest-environment node
import { stat } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { CHAT_CONTEXT_SNAPSHOT_END, CHAT_CONTEXT_SNAPSHOT_START } from "@multica/core/chat/context-snapshot";
import { generateLocalConversationTitle } from "./local-conversation-title-generator";
import { normalizeModelConversationTitle } from "./local-conversation-title";
import { createLocalTiming } from "@multica/tutti-agent-gui-host/local-timing";
import type { runLocalProvider } from "./local-provider-runner";

describe("model-generated conversation titles", () => {
  it.each(["codex", "claude"] as const)("uses an independent %s inference with the selected model and only the first authored message", async (provider) => {
    const run = vi.fn<typeof runLocalProvider>(async (input) => {
      expect((await stat(input.cwd)).isDirectory()).toBe(true);
      return { output: '"查看 TES-131 任务详情"', sessionId: "discarded-title-session" };
    });
    const timing = createLocalTiming({ source: "main", conversationId: "title", background: true }, vi.fn());
    const title = await generateLocalConversationTitle({ timing, provider, model: "selected-model", content: `[@TES-131 review 另一个 pr](mention://workspace-issue/issue?workspaceId=private) 里面有什么内容，你是如何读取的${CHAT_CONTEXT_SNAPSHOT_START}PRIVATE SNAPSHOT${CHAT_CONTEXT_SNAPSHOT_END}` }, new AbortController().signal, run);
    expect(title).toBe("查看 TES-131 任务详情");
    expect(run).toHaveBeenCalledOnce();
    const input = run.mock.calls[0]![0];
    expect(input).toMatchObject({ provider, model: "selected-model", titleOnly: true });
    expect(input.timing).toBe(timing);
    expect(input.resume).toBeUndefined(); expect(input.mcp).toBeUndefined();
    expect(JSON.parse(input.content)).toEqual({ first_user_message: "@TES-131 review 另一个 pr 里面有什么内容，你是如何读取的" });
    expect(input.systemPrompt).toContain("Summarize the main intent rather than copying");
    expect(input.content).not.toMatch(/PRIVATE SNAPSHOT|mention:|workspaceId/);
    await expect(stat(input.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds input and removes temporary files even when inference fails", async () => {
    const run = vi.fn<typeof runLocalProvider>(async () => { throw new Error("Provider unavailable"); });
    await expect(generateLocalConversationTitle({ provider: "codex", model: null, content: "登录问题".repeat(5000) }, new AbortController().signal, run)).rejects.toThrow("Provider unavailable");
    const input = run.mock.calls[0]![0];
    expect(JSON.parse(input.content).first_user_message.length).toBe(8000);
    await expect(stat(input.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a late response after cancellation and releases its temporary directory", async () => {
    const controller = new AbortController();
    const run = vi.fn<typeof runLocalProvider>(async () => { controller.abort(); return { output: "登录问题排查" }; });
    await expect(generateLocalConversationTitle({ provider: "claude", model: null, content: "帮我看看为什么登录不了" }, controller.signal, run)).rejects.toThrow("cancelled");
    await expect(stat(run.mock.calls[0]![0].cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels a stalled title request after its deadline", async () => {
    vi.useFakeTimers();
    try {
      let started!: () => void;
      const ready = new Promise<void>((resolve) => { started = resolve; });
      const run = vi.fn<typeof runLocalProvider>((_input, _emit, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Title timed out")), { once: true }); started();
      }));
      const pending = generateLocalConversationTitle({ provider: "codex", model: null, content: "排查登录失败" }, new AbortController().signal, run);
      const rejected = expect(pending).rejects.toThrow("Title timed out");
      await ready; await vi.advanceTimersByTimeAsync(45_000); await rejected;
      expect(run.mock.calls[0]![2].aborted).toBe(true);
      await expect(stat(run.mock.calls[0]![0].cwd)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { vi.useRealTimers(); }
  });

  it("does not invoke a provider for an empty source or an already cancelled request", async () => {
    const run = vi.fn<typeof runLocalProvider>();
    await expect(generateLocalConversationTitle({ provider: "codex", model: null, content: "![screenshot](data:image/png;base64,AA)" }, new AbortController().signal, run)).rejects.toThrow("No title source");
    await expect(generateLocalConversationTitle({ provider: "claude", model: null, content: "Review" }, AbortSignal.abort(), run)).rejects.toThrow("No title source");
    expect(run).not.toHaveBeenCalled();
  });

  it("accepts a concise model title and rejects prose or raw reference syntax", () => {
    expect(normalizeModelConversationTitle("  “排查登录失败”  ")).toBe("排查登录失败");
    for (const output of ["", "新会话", "Title\nHere is an explanation", "[@TES-131](mention://issue/131)", "Answer ".repeat(100)]) expect(normalizeModelConversationTitle(output)).toBeNull();
  });
});
