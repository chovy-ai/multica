// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readSavedPromptQueues } from "./saved-prompt-queues";

describe("saved prompt queue data", () => {
  it("rejects damaged entries without preventing intact queues from reopening", () => {
    const prompt = { id: "prompt", content: [{ type: "text", text: "Keep me" }], createdAtUnixMs: 1 };
    expect(readSavedPromptQueues([
      null, { agentSessionId: "bad", prompts: [{ ...prompt, content: "broken" }] },
      { agentSessionId: "session", prompts: [{ ...prompt, id: "bad", content: [{ type: "text", text: {} }] }, prompt, prompt] },
    ])).toEqual([{ agentSessionId: "session", prompts: [{ ...prompt, clientSubmitId: "prompt" }] }]);
    expect(readSavedPromptQueues({})).toEqual([]);
  });

  it("keeps durable attachment IDs and quoted references without storing expired image previews", () => {
    const queues = readSavedPromptQueues([{ agentSessionId: "session", prompts: [{
      id: "prompt", createdAtUnixMs: 1,
      content: [{ type: "text", text: "Read [@task](mention://workspace-issue/task)" }, { type: "image", assetId: "image", name: "screenshot.png", data: "large-preview", url: "blob:expired" }],
      runtimeContent: [{ type: "image", attachmentId: "image", url: "data:image/png;base64,preview" }],
    }] }]);
    expect(queues[0]!.prompts[0]).toMatchObject({ content: [{ text: "Read [@task](mention://workspace-issue/task)" }, { assetId: "image", attachmentId: "image", name: "screenshot.png" }], runtimeContent: [{ attachmentId: "image" }] });
    expect(JSON.stringify(queues)).not.toMatch(/large-preview|blob:expired|data:image/);
  });
});
