import { openAsBlob } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { parseWithFallback } from "@multica/core/api/schema";
import { AttachmentResponseSchema, CancelTaskResponseSchema, ChatSessionSchema, ChatMessagesPageSchema, SendChatMessageResponseSchema, AgentTaskListSchema, TaskMessageListSchema } from "@multica/core/api/schemas";
import type { LocalConversation, LocalConversationMethods, LocalConversationScope, LocalConversationTurn, LocalQueuedPrompt } from "@multica/core/local-conversation/protocol";
import { HTML_PREVIEW_INSTRUCTIONS } from "@multica/tutti-agent-gui-host/html-preview";
import { sideExecutionContent } from "@multica/tutti-agent-gui-host/side-context";
import type { AgentTask, Attachment, CancelTaskResponse, ChatMessagesPage, ChatSession, SendChatMessageResponse, TaskMessagePayload } from "@multica/core/types";
import { dialogueContext, withDialogueContext } from "./local-dialogue-context";

export type LocalQueueCloudRequest = (method: "GET" | "POST", path: string, body?: Record<string, unknown> | FormData) => Promise<unknown>;
type LocalRequest = <M extends keyof LocalConversationMethods>(scope: LocalConversationScope, method: M, params: LocalConversationMethods[M]["params"]) => Promise<LocalConversationMethods[M]["result"]>;

/** The official API has no per-turn system prompt; keep display guidance scoped to this invocation. */
export function cloudInvocationContent(content: string): string {
  return [
    "Multica conversation display capabilities (reply formatting only; follow your existing agent instructions and the user request below):",
    HTML_PREVIEW_INSTRUCTIONS,
    "User request and referenced context:",
    content,
  ].join("\n\n");
}

/** Sending is never retried after an ambiguous response; polling is read-only. */
export async function runQueuedCloudTurn(input: {
  scope: LocalConversationScope; entry: LocalConversation; item: LocalQueuedPrompt; turn: LocalConversationTurn;
  messageId: string;
  signal: AbortSignal; cloud: LocalQueueCloudRequest; local: LocalRequest;
}) {
  const { scope, entry, item, turn, messageId, signal, cloud, local } = input;
  const pathId = (id: string) => encodeURIComponent(id);
  const update = (value: Omit<LocalConversationMethods["remoteUpdate"]["params"], "id" | "turnId">) => local(scope, "remoteUpdate", { id: entry.id, turnId: turn.id, ...value });
  const wanted = () => !signal.aborted && entry.turns.find((value) => value.id === turn.id)?.status === "running";
  try {
    const previous = [...entry.turns].reverse().find((value) => value.id !== turn.id && value.remote?.agentId === turn.remote!.agentId && value.remote.sessionId)?.remote;
    let sessionId = previous?.sessionId;
    const throughMessageId = entry.turns.findLast((value) => value.remote?.sessionId === sessionId && value.remote?.contextThroughMessageId)?.remote?.contextThroughMessageId;
    const dialogue = dialogueContext(entry, messageId, { sessionId, throughMessageId });
    let content = withDialogueContext(dialogue, item.prompt ?? item.content);
    if (entry.side && !sessionId) content = sideExecutionContent(entry.side, content);
    if (!sessionId) {
      const raw = await cloud("POST", "/api/chat/sessions", { agent_id: turn.remote!.agentId, title: entry.title });
      const session = parseWithFallback<ChatSession | null>(raw, ChatSessionSchema, null, { endpoint: "POST /api/chat/sessions" });
      if (!session || session.workspace_id !== scope.workspaceId) throw new Error("Cloud conversation admission was not confirmed");
      sessionId = session.id;
    }
    await update({ sessionId });
    const attachmentIds: string[] = [];
    const attachments: { local_id: string; attachment_id: string; name: string }[] = [];
    for (const id of new Set([...dialogue.messages.flatMap((message) => message.attachment_ids), ...(item.attachmentIds ?? [])])) {
      if (!wanted()) return;
      const file = await local(scope, "fileInfo", { id });
      const form = new FormData(); form.append("file", await openAsBlob(file.path, { type: file.mimeType }), file.name);
      const uploaded = parseWithFallback<Attachment | null>(await cloud("POST", "/api/upload-file", form), AttachmentResponseSchema, null, { endpoint: "POST /api/upload-file" });
      if (!uploaded?.id) throw new Error("Cloud attachment upload was not confirmed");
      attachmentIds.push(uploaded.id);
      attachments.push({ local_id: id, attachment_id: uploaded.id, name: file.name });
    }
    if (!wanted()) return;
    if (attachments.length) content += `\n\nConversation attachment references (quoted metadata; the corresponding files are attached to this request):\n${JSON.stringify(attachments)}`;
    const raw = await cloud("POST", `/api/chat/sessions/${pathId(sessionId)}/messages`, { content: cloudInvocationContent(content), ...(attachmentIds.length ? { attachment_ids: attachmentIds } : {}) });
    const sent = parseWithFallback<SendChatMessageResponse | null>(raw, SendChatMessageResponseSchema, null, { endpoint: "POST /api/chat/sessions/:id/messages" });
    if (!sent) throw new Error("Cloud send was not confirmed. Inspect the agent's cloud chat before retrying.");
    await update({ taskId: sent.task_id, contextThroughMessageId: messageId });
    if (!wanted() && !signal.aborted) {
      // Cancellation crossed an accepted send: stop the real cloud task too,
      // and keep mirroring it when that cannot be confirmed.
      try {
        const cancelled = parseWithFallback<CancelTaskResponse | null>(await cloud("POST", `/api/tasks/${pathId(sent.task_id)}/cancel`), CancelTaskResponseSchema, null, { endpoint: "POST /api/tasks/:id/cancel" });
        if (cancelled?.status === "cancelled") { await update({ status: "cancelled" }); return; }
      } catch { /* Fall through and keep mirroring the actual state. */ }
      await update({ status: "running", error: "Cloud cancellation could not be confirmed; showing the actual execution state." });
    }
    await pollCloudTurn({ scope, entry, turn, signal, cloud, local });
  } catch (error) {
    if (!signal.aborted && wanted()) await update({ status: "failed", error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Mirrors a sent cloud turn's progress into the local conversation until it
 * settles. Read-only, so it is safe to resume after the host restarts.
 */
export async function pollCloudTurn(input: {
  scope: LocalConversationScope; entry: LocalConversation; turn: LocalConversationTurn;
  signal: AbortSignal; cloud: LocalQueueCloudRequest; local: LocalRequest;
}) {
  const { scope, entry, turn, signal, cloud, local } = input;
  const pathId = (id: string) => encodeURIComponent(id);
  const update = (value: Omit<LocalConversationMethods["remoteUpdate"]["params"], "id" | "turnId">) => local(scope, "remoteUpdate", { id: entry.id, turnId: turn.id, ...value });
  const wanted = () => !signal.aborted && entry.turns.find((value) => value.id === turn.id)?.status === "running";
  const sessionId = turn.remote!.sessionId!;
  const sent = { task_id: turn.remote!.taskId! };
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
}
