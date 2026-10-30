import type { AgentGuiSessionDetail } from "../protocol";

type Request = (method: string, params: any, options?: { signal?: AbortSignal }) => Promise<any>;

/**
 * Test hosts describe conversations as `session.load` details. This
 * answers the local v2 methods from the same detail, so a test's own
 * `session.load` overrides also shape the local snapshot.
 */
export function withLocalSnapshots(request: Request): Request {
  return async (method, params, options) => {
    if (method === "local.subscribe" || method === "local.unsubscribe") return undefined;
    // Keep the recorded call shape of hosts that never receive options.
    const call = (name: string, values: unknown) => options === undefined ? request(name, values) : request(name, values, options);
    if (method !== "local.snapshot") return call(method, params);
    const detail = await call("session.load", params) as AgentGuiSessionDetail;
    return { detail, snapshot: snapshotFromDetail(detail) };
  };
}

function snapshotFromDetail(detail: AgentGuiSessionDetail) {
  const at = detail.session.updated_at;
  const ids = [...new Set([
    ...(detail.tasks ?? []).map((task) => task.id),
    ...detail.messages.map((message) => message.task_id).filter((id): id is string => Boolean(id)),
    ...(detail.pending.task_id ? [detail.pending.task_id] : []),
  ])];
  let seq = 0;
  const turns = ids.map((id, index) => {
    const task = detail.tasks?.find((value) => value.id === id);
    const running = detail.pending.task_id === id;
    const status = task?.status === "failed" || task?.status === "cancelled" ? task.status : running ? "running" : "completed";
    const own = detail.messages.filter((message) => message.task_id === id || (running && !message.task_id));
    return {
      id, turn_index: index, request_id: "", status, started_at: task?.created_at ?? at,
      messages: own.filter((message) => message.role === "user").map((message) => ({
        id: message.id, role: "user", content: message.content, attachment_ids: (message.attachments ?? []).map((attachment) => attachment.id), created_at: message.created_at,
      })),
      events: own.filter((message) => message.role === "assistant").map((message) => ({
        seq: ++seq, turn_id: id, turn_seq: seq, item_id: `reply-${message.id}`, type: "item.completed", final: true, created_at: message.created_at,
        payload: { kind: "assistant_text", status: "completed", text: message.content },
      })),
    };
  });
  return {
    version: 2, store_generation: "test", snapshot_seq: seq, has_older_turns: false, turns, pending_interactions: [],
    conversation: { conversation_id: detail.session.id, summary_seq: 1, provider: "claude", title: detail.session.title, status: detail.pending.task_id ? "running" : "idle", pinned: false, archived: false, updated_at: at },
  };
}
