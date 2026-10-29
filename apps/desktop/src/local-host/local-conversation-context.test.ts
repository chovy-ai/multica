// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalConversationService } from "./local-conversation-service";
import type { LocalQueueCloudRequest } from "./local-queued-cloud-run";
import type { LocalProviderId, LocalQueuedPrompt } from "@multica/core/local-conversation/protocol";
import type { runLocalProvider } from "./local-provider-runner";

const scope = { userId: "user", workspaceId: "workspace" };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup(provider: LocalProviderId = "codex") {
  const root = await mkdtemp(join(tmpdir(), "multica-context-"));
  const sends: { session: string; content: string; attachmentIds: string[] }[] = [];
  const uploads: File[] = [];
  const cloud = vi.fn<LocalQueueCloudRequest>(async (method, path, body) => {
    if (path === "/api/upload-file") {
      const file = (body as FormData).get("file") as File; uploads.push(file);
      return { id: `uploaded-${uploads.length}`, url: "https://example.test/file", download_url: "https://example.test/file", filename: file.name };
    }
    if (path === "/api/chat/sessions") return { id: `session-${(body as Record<string, unknown>).agent_id}`, workspace_id: scope.workspaceId };
    if (method === "POST" && path.endsWith("/messages")) {
      const value = body as { content: string; attachment_ids?: string[] };
      const session = path.split("/")[4]!;
      sends.push({ session, content: value.content, attachmentIds: value.attachment_ids ?? [] });
      return { task_id: `task-${sends.length}`, message_id: `input-${sends.length}`, created_at: new Date().toISOString() };
    }
    if (path.includes("/messages/page")) return { messages: sends.map((send, index) => ({
      id: `reply-${index}`, chat_session_id: send.session, role: "assistant", task_id: `task-${index + 1}`,
      content: `AGENT_REPLY_${index + 1}: 补充到 CHOV-13，还是新建？`,
    })) };
    return [];
  });
  const run = vi.fn<typeof runLocalProvider>(async () => ({ output: "LOCAL_REPLY", sessionId: "native-session" }));
  const options = { root, apiUrl: "https://example.test", notify: vi.fn(), chooseDirectory: async () => "/test-owned", find: async () => "/test-owned/fake-cli", run, queueCloudClient: async () => cloud };
  const service = new LocalConversationService(options); service.setCurrentUser(scope.userId);
  cleanups.push(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
  const entry = await service.request(scope, "create", { provider });
  const settled = async (current = service) => {
    await vi.waitFor(async () => expect((await current.request(scope, "read", { id: entry.id })).turns.every((turn) => turn.status !== "running")).toBe(true));
  };
  const invoke = async (agentId: string, content: string, queued = false, current = service) => {
    const before = sends.length;
    const requestId = `request-${sends.length}-${agentId}`;
    const agents = [{ id: agentId, name: `Agent ${agentId}` }];
    if (queued) {
      const item: LocalQueuedPrompt = { requestId, content, agents, references: [{ kind: "agent", id: agentId }], display: { id: requestId, content: [{ type: "text", text: content }], createdAtUnixMs: Date.now() } };
      await current.request(scope, "queueEnqueue", { id: entry.id, item });
      await vi.waitFor(() => expect(sends.length).toBeGreaterThan(before));
    } else await current.request(scope, "remoteSend", { id: entry.id, content, agents, requestId });
    await settled(current);
  };
  return { service, options, entry, sends, uploads, cloud, run, settled, invoke };
}

describe("conversation context across local and defined agents", () => {
  it.each([false, true])("gives an invoked agent the preceding local dialogue and referenced task content (queued: %s)", async (queued) => {
    const { service, entry, sends, settled, invoke } = await setup();
    await service.request(scope, "send", { id: entry.id, content: "传递当前对话上下文", prompt: "传递当前对话上下文\nReferenced task: CHOV-13 ORIGINAL_TASK_DETAILS" });
    await settled();
    await invoke("a", "请分析", queued);
    expect(sends[0]!.content).toContain("ORIGINAL_TASK_DETAILS");
    expect(sends[0]!.content).toContain("LOCAL_REPLY");
    expect(sends[0]!.content).toContain("传递当前对话上下文");
  });

  it.each(["codex", "claude"] as const)("carries every agent's dialogue into the next %s turn and does not inject it again", async (provider) => {
    const { service, entry, run, settled, invoke } = await setup(provider);
    await service.request(scope, "send", { id: entry.id, content: "ORIGINAL_GOAL" }); await settled();
    await invoke("a", "A_INPUT");
    await invoke("b", "B_INPUT");
    await service.request(scope, "send", { id: entry.id, content: "补充" }); await settled();
    const continued = run.mock.calls[1]![0];
    expect(continued.resume).toBe("native-session");
    for (const text of ["A_INPUT", "AGENT_REPLY_1", "B_INPUT", "AGENT_REPLY_2", "补充"]) expect(continued.content).toContain(text);
    await service.request(scope, "send", { id: entry.id, content: "继续" }); await settled();
    expect(run.mock.calls[2]![0].content).toBe("继续");
  });

  it("accumulates cross-agent turns, resumes each agent and persists synchronization through restart", async () => {
    const { service, options, entry, sends, invoke } = await setup();
    await invoke("a", "FIRST_GOAL");
    await invoke("b", "SECOND_GOAL");
    expect(sends[1]!.content).toContain("FIRST_GOAL");
    expect(sends[1]!.content).toContain("AGENT_REPLY_1");
    await service.stop();
    const reopened = new LocalConversationService(options); reopened.setCurrentUser(scope.userId);
    cleanups.unshift(() => reopened.stop());
    await invoke("a", "补充", false, reopened);
    expect(sends[2]!.session).toBe("session-a");
    expect(sends[2]!.content).toContain("SECOND_GOAL");
    expect(sends[2]!.content).toContain("AGENT_REPLY_2");
    expect(sends[2]!.content).not.toContain("FIRST_GOAL");
    expect(sends[2]!.content).not.toContain("AGENT_REPLY_1");
    const saved = await reopened.request(scope, "read", { id: entry.id });
    expect(saved.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual(["FIRST_GOAL", "SECOND_GOAL", "补充"]);
  });

  it("gives every agent in one invocation the same preceding context and carries all results forward", async () => {
    const { service, entry, sends, settled, invoke } = await setup();
    await service.request(scope, "send", { id: entry.id, content: "SHARED_GOAL" }); await settled();
    await service.request(scope, "remoteSend", { id: entry.id, content: "GROUP_INPUT", requestId: "group", agents: [{ id: "a", name: "A" }, { id: "b", name: "B" }] });
    await settled();
    for (const send of sends) {
      expect(send.content).toContain("SHARED_GOAL");
      expect(send.content).not.toContain("AGENT_REPLY_");
      expect(send.content.match(/GROUP_INPUT/g)).toHaveLength(1);
    }
    await invoke("c", "Continue all reviews");
    for (const text of ["GROUP_INPUT", "AGENT_REPLY_1", "AGENT_REPLY_2"]) expect(sends[2]!.content).toContain(text);
    expect(sends[2]!.content).toContain('"name":"A"');
    expect(sends[2]!.content).toContain('"name":"B"');
  });

  it("retains the original goal beyond twenty messages and preserves full referenced content", async () => {
    const { service, entry, sends, settled, invoke } = await setup();
    const details = `ORIGINAL_TASK_DETAILS_${"x".repeat(33_000)}_END_OF_DETAILS`;
    await service.request(scope, "send", { id: entry.id, content: "LONG_CONVERSATION_GOAL", prompt: `LONG_CONVERSATION_GOAL ${details}` }); await settled();
    for (let index = 0; index < 11; index++) {
      await service.request(scope, "send", { id: entry.id, content: `Follow up ${index}` }); await settled();
    }
    await invoke("a", "补充");
    expect(sends[0]!.content).toContain("LONG_CONVERSATION_GOAL");
    expect(sends[0]!.content).toContain(details);
    await invoke("a", "新建");
    expect(sends[1]!.content).not.toContain(details);
    expect(sends[1]!.content).not.toContain("AGENT_REPLY_1");
    expect(sends[1]!.content).toContain("新建");
  });

  it("transfers preceding attachments to a new agent without embedding bytes or uploading them again to its existing session", async () => {
    const { service, entry, sends, uploads, settled, invoke } = await setup();
    const file = await service.request(scope, "fileStore", { name: "context.png", mimeType: "image/png", data: Buffer.from("TEST_IMAGE_BYTES").toString("base64") });
    await service.request(scope, "send", { id: entry.id, content: "Look at this attachment", attachmentIds: [file.id] }); await settled();
    await invoke("a", "Review the earlier screenshot");
    expect(uploads).toHaveLength(1);
    expect(await uploads[0]!.text()).toBe("TEST_IMAGE_BYTES");
    expect(sends[0]!.attachmentIds).toEqual(["uploaded-1"]);
    expect(sends[0]!.content).toContain(file.id);
    expect(sends[0]!.content).toContain('"attachment_id":"uploaded-1"');
    expect(sends[0]!.content).not.toContain("TEST_IMAGE_BYTES");
    await invoke("a", "补充");
    expect(uploads).toHaveLength(1);
    expect(sends[1]!.attachmentIds).toEqual([]);
    await invoke("b", "Review it too");
    expect(uploads).toHaveLength(2);
    expect(sends[2]!.attachmentIds).toEqual(["uploaded-2"]);
  });

  it("resolves attachments from agent turns when continuing locally and remembers that sync after restart", async () => {
    const { service, options, entry, run, settled } = await setup();
    await service.request(scope, "send", { id: entry.id, content: "Original goal" }); await settled();
    const file = await service.request(scope, "fileStore", { name: "agent-context.png", mimeType: "image/png", data: Buffer.from("TEST_BYTES").toString("base64") });
    const info = await service.request(scope, "fileInfo", file);
    await service.request(scope, "remoteSend", { id: entry.id, content: "Review screenshot", attachmentIds: [file.id], agents: [{ id: "a", name: "A" }] }); await settled();
    await service.request(scope, "send", { id: entry.id, content: "补充" }); await settled();
    expect(run.mock.calls[1]![0].content).toContain(info.path);
    expect(run.mock.calls[1]![0].content).toContain("AGENT_REPLY_1");
    await service.stop();
    const reopened = new LocalConversationService(options); reopened.setCurrentUser(scope.userId); cleanups.unshift(() => reopened.stop());
    await reopened.request(scope, "send", { id: entry.id, content: "继续" }); await settled(reopened);
    expect(run.mock.calls[2]![0].content).toBe("继续");
    expect(run.mock.calls[2]![0].resume).toBe("native-session");
  });

  it("does not advance local synchronization after failure, and carries the agent result on retry", async () => {
    const { service, entry, run, settled, invoke } = await setup();
    await service.request(scope, "send", { id: entry.id, content: "Original goal" }); await settled();
    await invoke("a", "Review");
    run.mockRejectedValueOnce(new Error("Provider failed before accepting context"));
    await service.request(scope, "send", { id: entry.id, content: "补充" }); await settled();
    await service.request(scope, "send", { id: entry.id, content: "继续" }); await settled();
    expect(run.mock.calls[1]![0].content).toContain("AGENT_REPLY_1");
    expect(run.mock.calls[2]![0].content).toContain("AGENT_REPLY_1");
  });

  it.each(["codex", "claude"] as const)("retains the original goal if %s failed before creating a native session", async (provider) => {
    const { service, entry, run, settled, invoke } = await setup(provider);
    run.mockRejectedValueOnce(new Error("No native session was created"));
    await service.request(scope, "send", { id: entry.id, content: "ORIGINAL_UNDELIVERED_GOAL" }); await settled();
    await invoke("a", "Review the original goal");
    await service.request(scope, "send", { id: entry.id, content: "补充" }); await settled();
    expect(run.mock.calls[1]![0].resume).toBeUndefined();
    for (const text of ["ORIGINAL_UNDELIVERED_GOAL", "No native session was created", "AGENT_REPLY_1"]) expect(run.mock.calls[1]![0].content).toContain(text);
  });

  it("reports an unconfirmed cloud send in subsequent context without automatically resubmitting it", async () => {
    const { service, entry, sends, cloud, settled, invoke } = await setup();
    const delegate = cloud.getMockImplementation()!;
    let rejectSend = true;
    cloud.mockImplementation(async (method, path, body) => {
      if (rejectSend && method === "POST" && path.endsWith("/messages")) throw new Error("Cloud write outcome unknown");
      return delegate(method, path, body);
    });
    await service.request(scope, "remoteSend", { id: entry.id, content: "UNCONFIRMED_GOAL", agents: [{ id: "a", name: "A" }] }); await settled();
    const failed = await service.request(scope, "read", { id: entry.id });
    expect(failed.turns[0]?.remote?.contextThroughMessageId).toBeUndefined();
    expect(cloud.mock.calls.filter(([method, path]) => method === "POST" && path.endsWith("/messages"))).toHaveLength(1);
    rejectSend = false;
    await invoke("b", "Inspect the previous attempt");
    expect(sends[0]!.content).toContain("UNCONFIRMED_GOAL");
    expect(sends[0]!.content).toContain("Cloud write outcome unknown");
    expect(sends[0]!.content).toContain('"execution_status":"failed"');
  });

  it("includes failed recipients without an assistant reply when a group has mixed outcomes", async () => {
    const { service, entry, run, settled } = await setup();
    const group = await service.request(scope, "remoteBegin", { id: entry.id, content: "GROUP_GOAL", agents: [{ id: "a", name: "A" }, { id: "b", name: "B" }] });
    await service.request(scope, "remoteUpdate", { id: entry.id, turnId: group.turns[0]!.id, output: "A_SUCCEEDED", status: "completed" });
    await service.request(scope, "remoteUpdate", { id: entry.id, turnId: group.turns[1]!.id, error: "B could not write the task", status: "failed" });
    await service.request(scope, "send", { id: entry.id, content: "现在是什么结果" }); await settled();
    expect(run.mock.calls[0]![0].content).toContain("A_SUCCEEDED");
    expect(run.mock.calls[0]![0].content).toContain('"agent_name":"B","status":"failed","error":"B could not write the task"');
  });

  it("keeps a native fork's synchronized boundary and does not inject previously received agent replies again", async () => {
    const { service, options, entry, run, settled, invoke } = await setup();
    Object.assign(options, { fork: vi.fn(async ({ through }: { through?: { prompts: string[]; index: number } }) => {
      expect(through).toBeDefined();
      const actual = run.mock.calls[through!.index]![0].content;
      expect(actual.startsWith(`${through!.prompts[through!.index]}\n\n`)).toBe(true);
      return "native-fork";
    }) });
    await invoke("a", "A_INPUT");
    const sent = await service.request(scope, "send", { id: entry.id, content: "补充" }); await settled();
    const branch = await service.request(scope, "fork", { id: entry.id, turnId: sent.turnId });
    expect(branch.providerContext?.sessionId).toBe("native-fork");
    expect(branch.messages.some((message) => message.id === branch.providerContext?.throughMessageId)).toBe(true);
    await service.request(scope, "send", { id: branch.id, content: "BRANCH_CONTINUE" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: branch.id })).turns.at(-1)?.status).toBe("completed"));
    expect(run.mock.calls[1]![0].content).toBe("BRANCH_CONTINUE");
    expect(run.mock.calls[1]![0].resume).toBe("native-fork");
  });

  it("inherits a Side's source snapshot once per new agent session without leaking later source messages", async () => {
    const { service, entry, sends, settled } = await setup();
    await service.request(scope, "send", { id: entry.id, content: "SOURCE_BOUNDARY" }); await settled();
    const side = await service.request(scope, "sideCreate", { id: entry.id, requestId: "side" });
    await service.request(scope, "send", { id: entry.id, content: "SOURCE_FUTURE" }); await settled();
    for (const agent of ["a", "a", "b"]) {
      await service.request(scope, "remoteSend", { id: side.id, content: "Analyze this Side", agents: [{ id: agent, name: agent }] });
      await vi.waitFor(async () => expect((await service.request(scope, "read", { id: side.id })).turns.at(-1)?.status).toBe("completed"));
    }
    expect(sends[0]!.content.match(/SOURCE_BOUNDARY/g)).toHaveLength(1);
    expect(sends[1]!.content).not.toContain("SOURCE_BOUNDARY");
    expect(sends[2]!.content.match(/SOURCE_BOUNDARY/g)).toHaveLength(1);
    expect(sends[2]!.content).toContain("AGENT_REPLY_1");
    expect(sends[2]!.content).toContain("AGENT_REPLY_2");
    for (const send of sends) expect(send.content).not.toContain("SOURCE_FUTURE");
  });
});
