import { setTimeout as delay } from "node:timers/promises";
import { parseWithFallback } from "@multica/core/api/schema";
import { AttachmentResponseSchema, ChatSessionSchema, ChatMessagesPageSchema, SendChatMessageResponseSchema, AgentTaskListSchema, TaskMessageListSchema } from "@multica/core/api/schemas";
import type { LocalConversation, LocalConversationMethods, LocalConversationScope, LocalConversationTurn, LocalQueuedPrompt } from "@multica/tutti-agent-gui-host/local-protocol";
import { HTML_PREVIEW_INSTRUCTIONS } from "@multica/tutti-agent-gui-host/html-preview";
import { sideExecutionContent } from "@multica/tutti-agent-gui-host/side-context";
import type { AgentTask, Attachment, ChatMessagesPage, ChatSession, SendChatMessageResponse, TaskMessagePayload } from "@multica/core/types";

export type LocalQueueCloudRequest = (method: "GET" | "POST", path: string, body?: Record<string, unknown> | FormData) => Promise<unknown>;
type LocalRequest = <M extends keyof LocalConversationMethods>(scope: LocalConversationScope, method: M, params: LocalConversationMethods[M]["params"]) => Promise<LocalConversationMethods[M]["result"]>;

/** Sending is never retried after an ambiguous response; polling is read-only. */
export async function runQueuedCloudTurn(input: {
  scope: LocalConversationScope; entry: LocalConversation; item: LocalQueuedPrompt; turn: LocalConversationTurn;
  signal: AbortSignal; cloud: LocalQueueCloudRequest; local: LocalRequest;
}) {
  const { scope, entry, item, turn, signal, cloud, local } = input;
  const pathId = (id: string) => encodeURIComponent(id);
  const update = (value: Omit<LocalConversationMethods["remoteUpdate"]["params"], "id" | "turnId">) => local(scope, "remoteUpdate", { id: entry.id, turnId: turn.id, ...value });
  const wanted = () => !signal.aborted && entry.turns.find((value) => value.id === turn.id)?.status === "running";
  try {
    let sessionId = [...entry.turns].reverse().find((value) => value.id !== turn.id && value.remote?.agentId === turn.remote!.agentId && value.remote.sessionId)?.remote?.sessionId;
    if (!sessionId) {
      const raw = await cloud("POST", "/api/chat/sessions", { agent_id: turn.remote!.agentId, title: entry.title });
      const session = parseWithFallback<ChatSession | null>(raw, ChatSessionSchema, null, { endpoint: "POST /api/chat/sessions" });
      if (!session || session.workspace_id !== scope.workspaceId) throw new Error("Cloud conversation admission was not confirmed");
      sessionId = session.id;
    }
    await update({ sessionId });
    const attachmentIds: string[] = [];
    for (const id of item.attachmentIds ?? []) {
      if (!wanted()) return;
      const file = await local(scope, "fileRead", { id });
      const form = new FormData(); form.append("file", new Blob([new Uint8Array(Buffer.from(file.data, "base64"))], { type: file.mimeType }), file.name);
      const uploaded = parseWithFallback<Attachment | null>(await cloud("POST", "/api/upload-file", form), AttachmentResponseSchema, null, { endpoint: "POST /api/upload-file" });
      if (!uploaded?.id) throw new Error("Cloud attachment upload was not confirmed");
      attachmentIds.push(uploaded.id);
    }
    if (!wanted()) return;
    const content = entry.side ? sideExecutionContent(entry.side, item.prompt ?? item.content) : item.prompt ?? item.content;
    const raw = await cloud("POST", `/api/chat/sessions/${pathId(sessionId)}/messages`, { content: `${HTML_PREVIEW_INSTRUCTIONS}\n\nUser request and referenced context:\n${content}`, ...(attachmentIds.length ? { attachment_ids: attachmentIds } : {}) });
    const sent = parseWithFallback<SendChatMessageResponse | null>(raw, SendChatMessageResponseSchema, null, { endpoint: "POST /api/chat/sessions/:id/messages" });
    if (!sent) throw new Error("Cloud send was not confirmed. Inspect the agent's cloud chat before retrying.");
    await update({ taskId: sent.task_id });
    while (wanted()) {
      try {
        const [messagesRaw, eventsRaw, tasksRaw] = await Promise.all([
          cloud("GET", `/api/chat/sessions/${pathId(sessionId)}/messages/page?limit=100`),
          cloud("GET", `/api/tasks/${pathId(sent.task_id)}/messages`),
          cloud("GET", `/api/agents/${pathId(turn.remote!.agentId)}/tasks?limit=200`),
        ]);
        const messages = parseWithFallback<ChatMessagesPage | null>(messagesRaw, ChatMessagesPageSchema, null, { endpoint: "GET /api/chat/sessions/:id/messages/page" });
        const events = parseWithFallback<TaskMessagePayload[]>(eventsRaw, TaskMessageListSchema, [], { endpoint: "GET /api/tasks/:id/messages" });
        const tasks = parseWithFallback<AgentTask[]>(tasksRaw, AgentTaskListSchema, [], { endpoint: "GET /api/agents/:id/tasks" });
        const reply = messages?.messages.find((message) => message.role === "assistant" && message.task_id === sent.task_id);
        const task = tasks.find((value) => value.id === sent.task_id && value.chat_session_id === sessionId);
        await update({ events: events.map((event) => ({ ...event, created_at: event.created_at || new Date().toISOString() })), ...(reply ? { output: reply.content, status: reply.failure_reason ? "failed" : "completed" }
          : task && ["failed", "cancelled"].includes(task.status) ? { status: task.status as "failed" | "cancelled", error: task.error ?? undefined } : {}) });
      } catch { signal.throwIfAborted(); }
      if (wanted()) await delay(2000, undefined, { signal });
    }
  } catch (error) {
    if (!signal.aborted && wanted()) await update({ status: "failed", error: error instanceof Error ? error.message : String(error) });
  }
}
