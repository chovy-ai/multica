// @vitest-environment node
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { FileCapture, type FileCaptureEvidence } from "./file-capture";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "multica-file-capture-")); roots.push(root);
  const frames: FileCaptureEvidence[] = [];
  const capture = new FileCapture(async frame => { frames.push(frame); }); capture.configure(root); capture.begin("request-1");
  const hook = async (name: keyof NonNullable<typeof capture.hooks>, input: Record<string, unknown>, id = "tool") => {
    const callback = capture.hooks?.[name]?.[0]?.hooks[0];
    return callback?.({ session_id: "session", transcript_path: "unused", cwd: root, hook_event_name: name, ...input } as HookInput, id, { signal: new AbortController().signal });
  };
  return { root, frames, capture, hook };
}
it("captures exact Write/Edit evidence, including pre-existing user content and tool ownership", async () => {
  const f = await fixture(); await writeFile(join(f.root, "a"), "user\nA\n");
  const input = { tool_name: "Edit", tool_input: { file_path: "a", old_string: "A", new_string: "B" } };
  expect(await f.hook("PreToolUse", input)).toEqual({});
  f.capture.begin("request-2"); await writeFile(join(f.root, "a"), "user\nB\n");
  expect(await f.hook("PostToolUse", input)).toEqual({});
  expect(f.frames[0]).toMatchObject({ request_id: "request-1", reason: "", before: { content: "user\nA\n" }, after: { content: "user\nB\n" } });
});
it("keeps failed/no-write operations out and marks mismatched actual writes uncertain", async () => {
  const f = await fixture(); await writeFile(join(f.root, "a"), "A");
  const input = { tool_name: "Write", tool_input: { file_path: "a", content: "B" } };
  await f.hook("PreToolUse", input); await f.hook("PostToolUseFailure", input); expect(f.frames).toEqual([]);
  await f.hook("PreToolUse", input); await writeFile(join(f.root, "a"), "external"); await f.hook("PostToolUse", input);
  expect(f.frames[0]?.reason).toBe("uncertain");
});
it("does not read excluded credentials or follow a directory escape", async () => {
  const f = await fixture(); await writeFile(join(f.root, ".env"), "secret");
  const outside = await mkdtemp(join(tmpdir(), "multica-file-outside-")); roots.push(outside);
  await writeFile(join(outside, "private"), "secret"); await symlink(outside, join(f.root, "escape"));
  for (const file_path of [".env", "escape/private"]) {
    const input = { tool_name: "Write", tool_input: { file_path, content: "attempt" } };
    await f.hook("PreToolUse", input, file_path); await f.hook("PostToolUse", input, file_path);
  }
  expect(f.frames.every(frame => !frame.before.content && !frame.after.content && frame.reason)).toBe(true);
});
it("preserves the spawning turn for subagent tools after the main conversation continues", async () => {
  const f = await fixture(); await f.hook("SubagentStart", { agent_id: "child" });
  f.capture.begin("request-2");
  const input = { agent_id: "child", tool_name: "Write", tool_input: { file_path: "new", content: "new" } };
  await f.hook("PreToolUse", input); await writeFile(join(f.root, "new"), "new"); await f.hook("PostToolUse", input);
  expect(f.frames[0]?.request_id).toBe("request-1");
});
