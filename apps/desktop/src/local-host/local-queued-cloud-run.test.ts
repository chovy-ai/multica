// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalConversation, LocalConversationScope } from "@multica/core/local-conversation/protocol";
import { runQueuedCloudTurn, type LocalQueueCloudRequest } from "./local-queued-cloud-run";

const scope = { userId: "test-user", workspaceId: "test-workspace" };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function conversation(): LocalConversation {
  return {
    id: "source-local", title: "Bug discussion", provider: "codex", cwd: "/unused", pinned: false, archived: false, model: null,
    createdAt: "2026-10-29T00:00:00Z", updatedAt: "2026-10-29T00:00:00Z",
    messages: [
      { id: "original", role: "user", content: "CHOV-12: screenshot shows protocol rejection", turnId: "prior", createdAt: "2026-10-29T00:00:00Z" },
      { id: "analysis", role: "assistant", content: "The failure happens after three seconds", turnId: "prior", createdAt: "2026-10-29T00:01:00Z" },
      { id: "trigger", role: "user", content: "记录一下", turnId: "current", createdAt: "2026-10-29T00:02:00Z" },
    ],
    turns: [{ id: "current", createdAt: "2026-10-29T00:02:00Z", status: "running", events: [], remote: { agentId: "bug-agent", agentName: "Bug agent" } }],
  };
}
async function invoke(entry: LocalConversation, options: {
  turnId?: string; currentFiles?: string[]; missingFile?: boolean;
  beforeAdmission?: () => void; uploadFailure?: boolean; ambiguousSend?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "multica-cloud-context-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, "image.png");
  await writeFile(filePath, "test-owned image bytes");
  const turn = entry.turns.find((value) => value.id === (options.turnId ?? "current"))!;
  const controller = new AbortController();
  const uploads: { id: string; filename: string; content: string }[] = [];
  const cloud = vi.fn<LocalQueueCloudRequest>(async (method, path, body) => {
    if (path === "/api/chat/sessions") { options.beforeAdmission?.(); return { id: "cloud-session", workspace_id: scope.workspaceId }; }
    if (path === "/api/upload-file") {
      if (options.uploadFailure) throw new Error("Upload unavailable");
      const file = (body as FormData).get("file") as File;
      const id = `cloud-file-${uploads.length}`;
      uploads.push({ id, filename: file.name, content: await file.text() });
      return { id, filename: file.name, url: `/files/${id}`, download_url: `/files/${id}` };
    }
    if (method === "POST" && path.endsWith("/messages")) {
      if (options.ambiguousSend) throw new Error("Connection lost after send");
      return { message_id: "cloud-message", task_id: "cloud-task", created_at: "2026-10-29T00:03:00Z" };
    }
    throw new Error(`Unexpected cloud request: ${method} ${path}`);
  });
  const local = vi.fn(async (currentScope: LocalConversationScope, method: string, params: Record<string, unknown>) => {
    expect(currentScope).toEqual(scope);
    if (method === "fileInfo") {
      if (options.missingFile) throw new Error("Source image unavailable");
      return { id: params.id, path: filePath, name: `${params.id}.png`, mimeType: "image/png", size: 22, url: "unused" };
    }
    expect(method).toBe("remoteUpdate");
    Object.assign(turn.remote!, params.sessionId ? { sessionId: params.sessionId } : {}, params.taskId ? { taskId: params.taskId } : {});
    if (params.status) Object.assign(turn, { status: params.status, error: params.error });
    // Finish at the accepted-send boundary. Existing queue tests cover result polling.
    if (params.taskId) controller.abort();
    return turn;
  });
  await runQueuedCloudTurn({ scope, entry, item: { requestId: "request", content: "记录一下", attachmentIds: options.currentFiles, display: { id: "request", clientSubmitId: "request", content: [], createdAtUnixMs: 0 } },
    turn, messageId: "trigger", signal: controller.signal, cloud, local: local as Parameters<typeof runQueuedCloudTurn>[0]["local"] });
  const sends = cloud.mock.calls.filter(([method, path]) => method === "POST" && path.endsWith("/messages"));
  return { cloud, local, uploads, sends, body: sends[0]?.[2] as { content: string; attachment_ids?: string[] } | undefined };
}

describe("local context on every defined-agent invocation", () => {
  it("carries the source discussion, roles, boundary and request into the first invocation", async () => {
    const { body } = await invoke(conversation());
    expect(body?.content).toContain("CHOV-12");
    expect(body?.content).toContain("The failure happens after three seconds");
    expect(body?.content).toContain("source-local");
    expect(body?.content).toContain("test-workspace");
    expect(body?.content).toContain('"role":"assistant"');
    expect(body?.content).toContain("trigger");
    expect(body?.content.match(/记录一下/g)).toHaveLength(1);
  });
  it("uploads historical and current files once each with usable cloud IDs", async () => {
    const entry = conversation(); entry.messages[0]!.attachmentIds = ["screenshot", "shared"];
    const { body, uploads, local } = await invoke(entry, { currentFiles: ["shared", "current-file"] });
    expect(uploads.map((file) => file.filename)).toEqual(["screenshot.png", "shared.png", "current-file.png"]);
    expect(uploads.every((file) => file.content === "test-owned image bytes")).toBe(true);
    expect(body?.attachment_ids).toEqual(uploads.map((file) => file.id));
    expect(body?.content).toContain('"attachment_ids":["cloud-file-0","cloud-file-1"]');
    expect(local.mock.calls.filter(([, method]) => method === "fileInfo")).toHaveLength(3);
    expect(body?.content).not.toContain("/unused");
  });
  it("refreshes intervening local context when reusing the agent's cloud chat", async () => {
    const entry = conversation();
    entry.turns.unshift({ id: "previous", createdAt: entry.createdAt, status: "completed", events: [], remote: { agentId: "bug-agent", agentName: "Bug agent", sessionId: "existing-cloud" } });
    entry.messages.splice(2, 0, { id: "new", role: "assistant", content: "NEW_LOCAL_EVIDENCE", createdAt: entry.createdAt, turnId: "local-turn" });
    const { body, cloud } = await invoke(entry);
    expect(body?.content).toContain("NEW_LOCAL_EVIDENCE");
    expect(cloud.mock.calls.some(([, path]) => path === "/api/chat/sessions")).toBe(false);
    expect(cloud.mock.calls.some(([, path]) => path === "/api/chat/sessions/existing-cloud/messages")).toBe(true);
  });
  it("freezes the source boundary before admission and excludes later or parallel output", async () => {
    const entry = conversation();
    const { body, uploads } = await invoke(entry, { beforeAdmission: () => {
      entry.messages[0]!.content = "MUTATED_AFTER_ADMISSION";
      entry.messages[0]!.attachmentIds = ["added-after-boundary"];
      entry.messages.push({ id: "later", role: "assistant", content: "PARALLEL_AGENT_OUTPUT", turnId: "other-agent", createdAt: entry.updatedAt, attachmentIds: ["later-file"] });
    } });
    expect(body?.content).toContain("CHOV-12");
    expect(body?.content).not.toMatch(/MUTATED_AFTER_ADMISSION|PARALLEL_AGENT_OUTPUT/);
    expect(uploads).toEqual([]);
  });
  it("uses the same input boundary for another agent in the invocation", async () => {
    const entry = conversation();
    entry.turns.push({ id: "second-agent", status: "running", createdAt: entry.updatedAt, events: [], remote: { agentId: "another-agent", agentName: "Another agent" } });
    const { body } = await invoke(entry, { turnId: "second-agent" });
    expect(body?.content).toContain("CHOV-12");
    expect(body?.content.match(/记录一下/g)).toHaveLength(1);
  });
  it("preserves full long history in a downloadable attachment while bounding inline context", async () => {
    const entry = conversation();
    entry.messages[0]!.content = `EARLIEST_EVIDENCE${"x".repeat(150_000)}`;
    const { body, uploads } = await invoke(entry);
    const transcript = uploads.find((file) => file.filename.endsWith(".json"))!;
    expect(transcript).toBeDefined();
    expect(JSON.parse(transcript.content).messages[0].content).toBe(entry.messages[0]!.content);
    expect(body?.attachment_ids).toContain(transcript.id);
    expect(body?.content).toContain(`multica attachment download ${transcript.id}`);
    expect(body?.content).toContain("The failure happens after three seconds");
    expect(body!.content.length).toBeLessThan(40_000);
  });
  it("includes the saved Side boundary without reading the live source conversation", async () => {
    const entry = conversation();
    entry.side = { sourceId: "parent-local", requestId: "side", turnId: "selected-turn", context: [{ role: "user", content: "SIDE_INHERITED_CONTEXT" }], quote: "Selected evidence" };
    const { body, local } = await invoke(entry);
    expect(body?.content).toContain("SIDE_INHERITED_CONTEXT");
    expect(body?.content).toContain("Selected evidence");
    expect(local.mock.calls.some(([, method]) => method === "read")).toBe(false);
  });
  it.each(["missing", "upload"])("fails visibly without sending incomplete historical context (%s)", async (failure) => {
    const entry = conversation(); entry.messages[0]!.attachmentIds = ["screenshot"];
    const { sends } = await invoke(entry, { missingFile: failure === "missing", uploadFailure: failure === "upload" });
    expect(sends).toHaveLength(0);
    expect(entry.turns[0]).toMatchObject({ status: "failed", error: failure === "missing" ? "Source image unavailable" : "Upload unavailable" });
  });
  it("never retries an ambiguous send containing the source context", async () => {
    const entry = conversation();
    const { sends } = await invoke(entry, { ambiguousSend: true });
    expect(sends).toHaveLength(1);
    expect(entry.turns[0]).toMatchObject({ status: "failed", error: "Connection lost after send" });
  });
});
