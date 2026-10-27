import type { LocalConversation } from "@multica/tutti-agent-gui-host/local-protocol";

export type SideActivityState = "idle" | "running" | "waiting" | "completed" | "failed" | "cancelled";

/** Derive display information from this conversation only, without exposing reasoning. */
export function localSideActivity(session?: LocalConversation) {
  const turn = session?.turns.filter((turn) => turn.status === "running").at(-1) ?? session?.turns.at(-1);
  const background = session?.turns.flatMap((turn) => turn.backgroundTasks?.filter((task) => task.status === "running") ?? []) ?? [];
  const dispatching = !!session?.promptQueue?.dispatchingRequestId;
  const running = turn?.status === "running" || background.length > 0 || dispatching;
  const waiting = running && turn?.questions?.some((question) => question.status === "pending");
  const events = dispatching && turn?.status !== "running" ? [] : turn?.events ?? [];
  const tools = events.filter((event) => event.type === "tool_use");
  const results = new Set(events.filter((event) => event.type === "tool_result" && event.call_id).map((event) => event.call_id));
  const completedTools = tools.filter((tool) => tool.call_id && results.has(tool.call_id)).length;
  const last = events.filter((event) => ["text", "thinking", "tool_use", "tool_result"].includes(event.type)).at(-1);
  const tool = last?.type === "tool_use" ? last.tool : last?.type === "tool_result" ? tools.find((tool) => tool.call_id === last.call_id)?.tool : undefined;
  const output = session?.messages.filter((message) => message.role === "assistant" && (!turn || message.turnId === turn.id)).at(-1)?.content.trim()
    || events.filter((event) => event.type === "text").map((event) => event.content ?? "").join("").trim()
    || "";
  const state: SideActivityState = waiting ? "waiting" : running ? "running" : turn?.status ?? (output ? "completed" : "idle");
  return {
    state, spinning: running && !waiting,
    tool, toolFinished: last?.type === "tool_result", completedTools, totalTools: tools.length,
    thinking: last?.type === "thinking",
    background: background.map((task) => task.progressSummary || task.description).filter(Boolean).join(" · "),
    output: dispatching ? "" : output,
    error: state === "failed" ? turn?.error : undefined,
  };
}
