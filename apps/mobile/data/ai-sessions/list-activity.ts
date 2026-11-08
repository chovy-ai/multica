import type { LocalV2Summary } from "@multica/core/local-conversation/v2";

export function sessionListActivity(summary: Pick<LocalV2Summary, "status" | "pending_interactions" | "background_tasks">) {
  if (summary.status === "running") return summary.pending_interactions > 0 ? "pending_question" : "session_running";
  return summary.background_tasks > 0 ? "session_background" : null;
}
