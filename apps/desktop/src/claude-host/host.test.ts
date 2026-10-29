// @vitest-environment node
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ClaudeSdk } from "./adapter";
import { runClaudeHost } from "./host";

type Frame = Record<string, any>;

/** A Query whose output the test pushes, recording every SDK call. */
function fakeQuery() {
  const pending: Frame[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const iterator = (async function* () {
    while (true) {
      const next = pending.shift();
      if (next) { yield next; continue; }
      if (closed) return;
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  })();
  const query = Object.assign(iterator, {
    supportedModels: vi.fn(async () => [{ value: "claude-opus-5-5" }]),
    setModel: vi.fn(async () => {}),
    setPermissionMode: vi.fn(async () => {}),
    applyFlagSettings: vi.fn(async () => {}),
    setMcpServers: vi.fn(async () => ({ added: [], removed: [], errors: {} })),
    stopTask: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(() => { closed = true; wake?.(); }),
  });
  return { query, emit: (message: Frame) => { pending.push(message); wake?.(); }, end: () => { closed = true; wake?.(); } };
}

function harness() {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: Frame[] = [];
  let buffer = "";
  output.on("data", (chunk) => {
    buffer += String(chunk);
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) { frames.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1); }
  });
  const fake = fakeQuery();
  const prompts: AsyncIterable<any>[] = [];
  const sdk = {
    query: vi.fn(({ prompt }: { prompt: AsyncIterable<any>; options: Record<string, unknown> }) => { prompts.push(prompt); return fake.query; }),
    forkSession: vi.fn(async () => ({ sessionId: "child-session" })),
    listSessions: vi.fn(async () => [{ sessionId: "s1" }]),
    getSessionMessages: vi.fn(async () => [{ uuid: "u1", type: "user" }]),
  };
  const exit = vi.fn();
  runClaudeHost({ input, output, sdk: async () => sdk as unknown as ClaudeSdk, exit });
  const send = (frame: Frame) => input.write(`${JSON.stringify({ version: 1, ...frame })}\n`);
  const waitFor = async (predicate: (frame: Frame) => boolean) => {
    await vi.waitFor(() => { if (!frames.some(predicate)) throw new Error("frame not yet written"); });
    return frames.find(predicate)!;
  };
  return { input, frames, fake, sdk, prompts, exit, send, waitFor };
}

const start = { id: "r1", type: "start", executable: "/bin/claude", cwd: "/repo" };

describe("Claude host", () => {
  it("announces itself with the pinned SDK version", async () => {
    const h = harness();
    const ready = await h.waitFor((f) => f.type === "ready");
    expect(ready).toMatchObject({ version: 1, sdk_version: expect.any(String) });
  });

  it("starts one Query with the conversation's options and returns the model catalog", async () => {
    const h = harness();
    h.send({ ...start, resume: "native-1", model: "claude-opus-5-5", reasoning_effort: "high", permission_mode: "full-access",
      append_system_prompt: "ctx", mcp_servers: { multica: { type: "http", url: "http://127.0.0.1:1/mcp/t" } }, allowed_tools: ["mcp__multica__*"] });
    const result = await h.waitFor((f) => f.type === "result" && f.id === "r1");
    expect(result.data).toEqual({ models: [{ value: "claude-opus-5-5" }] });
    const options = h.sdk.query.mock.calls[0]![0].options;
    expect(options).toMatchObject({
      pathToClaudeCodeExecutable: "/bin/claude", cwd: "/repo", resume: "native-1", model: "claude-opus-5-5", effort: "high",
      permissionMode: "bypassPermissions", strictMcpConfig: true, includePartialMessages: true,
      systemPrompt: { type: "preset", preset: "claude_code", append: "ctx", snapshot: false }, allowedTools: ["mcp__multica__*"],
    });
  });

  it("forwards SDK messages unchanged and queues user turns on the same Query", async () => {
    const h = harness();
    h.send(start);
    await h.waitFor((f) => f.id === "r1");
    h.fake.emit({ type: "system", subtype: "init", session_id: "native-2" });
    await h.waitFor((f) => f.type === "sdk_message" && f.message.subtype === "init");
    h.send({ id: "r2", type: "send", request_id: "5f0c2f7e-1111-4222-8333-944445555666", content: [{ type: "text", text: "hi" }] });
    await h.waitFor((f) => f.id === "r2" && f.type === "result");
    h.fake.emit({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } });

    const forwarded = await h.waitFor((f) => f.type === "sdk_message" && f.message.type === "assistant");
    expect(forwarded).toEqual({ version: 1, type: "sdk_message", query_generation: 1, message: { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } } });
    const iterator = h.prompts[0]![Symbol.asyncIterator]();
    const prompt = await iterator.next();
    expect(prompt.value).toMatchObject({ type: "user", uuid: "5f0c2f7e-1111-4222-8333-944445555666", session_id: "native-2", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
    expect(h.sdk.query).toHaveBeenCalledTimes(1);
  });

  it("maps runtime setting changes to the Query", async () => {
    const h = harness();
    h.send(start);
    await h.waitFor((f) => f.id === "r1");
    h.send({ id: "a", type: "set_model", model: null });
    h.send({ id: "b", type: "set_permission_mode", mode: "auto" });
    h.send({ id: "c", type: "apply_flag_settings", settings: { effortLevel: "low" } });
    h.send({ id: "d", type: "stop_task", task_id: "task-1" });
    for (const id of ["a", "b", "c", "d"]) await h.waitFor((f) => f.id === id && f.type === "result");
    expect(h.fake.query.setModel).toHaveBeenCalledWith(undefined);
    expect(h.fake.query.setPermissionMode).toHaveBeenCalledWith("auto");
    expect(h.fake.query.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: "low" });
    expect(h.fake.query.stopTask).toHaveBeenCalledWith("task-1");
  });

  it("closes the Query transport when an interrupt is not acknowledged in time", async () => {
    const h = harness();
    h.send(start);
    await h.waitFor((f) => f.id === "r1");
    h.fake.query.interrupt.mockImplementation(() => new Promise(() => {}));
    h.send({ id: "r2", type: "interrupt", deadline_ms: 10 });
    const result = await h.waitFor((f) => f.id === "r2");
    expect(result.data).toEqual({ outcome: "closed" });
    expect(h.fake.query.close).toHaveBeenCalled();
  });

  it("reports send before start as not dispatched", async () => {
    const h = harness();
    h.send({ id: "r2", type: "send", request_id: "req", content: [] });
    expect(await h.waitFor((f) => f.id === "r2")).toMatchObject({ type: "error", code: "not_started", dispatch: "not_dispatched" });
  });

  it("reports an unexpected end of the SDK stream", async () => {
    const h = harness();
    h.send(start);
    await h.waitFor((f) => f.id === "r1");
    h.fake.end();
    expect(await h.waitFor((f) => f.type === "error" && !f.id)).toMatchObject({ code: "query_ended" });
  });

  it("serves one-shot fork, history and model requests through the SDK", async () => {
    const h = harness();
    h.send({ id: "f", type: "fork_session", session_id: "src", dir: "/repo", title: "Fork", up_to_message_id: "u9" });
    h.send({ id: "l", type: "list_sessions", limit: 50 });
    h.send({ id: "g", type: "get_session_messages", session_id: "src", dir: "/repo" });
    h.send({ id: "m", type: "supported_models", executable: "/bin/claude" });
    expect((await h.waitFor((f) => f.id === "f")).data).toEqual({ session_id: "child-session" });
    expect(h.sdk.forkSession).toHaveBeenCalledWith("src", { dir: "/repo", title: "Fork", upToMessageId: "u9" });
    expect((await h.waitFor((f) => f.id === "l")).data).toEqual([{ sessionId: "s1" }]);
    expect((await h.waitFor((f) => f.id === "g")).data).toEqual([{ uuid: "u1", type: "user" }]);
    expect((await h.waitFor((f) => f.id === "m")).data).toEqual({ models: [{ value: "claude-opus-5-5" }] });
    expect(h.sdk.query.mock.calls[0]![0].options).toMatchObject({ persistSession: false, mcpServers: {}, tools: [] });
  });

  it("rejects malformed requests with their id and keeps running", async () => {
    const h = harness();
    h.send({ id: "bad", type: "start", cwd: "/repo" });
    expect(await h.waitFor((f) => f.id === "bad")).toMatchObject({ type: "error", code: "invalid_request" });
    expect(h.exit).not.toHaveBeenCalled();
  });

  it("exits on an unsupported protocol version", async () => {
    const h = harness();
    h.input.write(`${JSON.stringify({ version: 2, id: "r1", type: "close" })}\n`);
    expect(await h.waitFor((f) => f.code === "unsupported_version")).toMatchObject({ type: "error" });
    await vi.waitFor(() => expect(h.exit).toHaveBeenCalledWith(2));
  });

  it("closes the session and exits when the daemon closes stdin", async () => {
    const h = harness();
    h.send(start);
    await h.waitFor((f) => f.id === "r1");
    h.input.end();
    await vi.waitFor(() => expect(h.exit).toHaveBeenCalledWith(0));
    expect(h.fake.query.close).toHaveBeenCalled();
  });
});
