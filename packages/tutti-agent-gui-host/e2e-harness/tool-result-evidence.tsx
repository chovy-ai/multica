import React from "react";
import { createRoot } from "react-dom/client";
import { ConversationModel, TranscriptModel } from "@multica/conversation-client/models";
import { localV2SnapshotSchema } from "@multica/core/local-conversation/v2";
import { CommittedConversationMessages } from "../../../vendor/tutti/packages/agent/gui/state/CommittedConversationMessages";
import { projectWorkspaceAgentMessagesToTimelineItems } from "../../../vendor/tutti/packages/agent/gui/shared/agentConversation/projection/workspaceAgentMessageProjection";
import { toolCallView } from "../../../vendor/tutti/packages/agent/gui/shared/workspaceAgentTimelineProjectionHelpers";
import { projectAgentToolCall } from "../../../vendor/tutti/packages/agent/gui/shared/agentConversation/projection/agentToolProjection";
import { AgentExpandedToolContent } from "../../../vendor/tutti/packages/agent/gui/shared/agentConversation/components/tool-renderers/AgentExpandedToolContent";
import "../src/agent-gui.generated.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") ?? "light";
document.documentElement.className = `multica-agent-gui ${theme === "dark" ? "dark" : ""}`;
document.documentElement.dataset.theme = theme;
const at = "2026-11-14T09:00:00Z";
const scenario = params.get("scenario") ?? "full";
const payload = {
  kind: "command", status: "completed", command: "python3 update_notes.py", output: "Updated notes successfully.\n", exit_code: 0,
  ...(scenario === "before" ? {} : {
    file_changes: scenario === "paths" ? [{ path: "docs/engineering/agent-memory.md", kind: "update" }] : [{ path: "docs/engineering/agent-memory.md", kind: "update", diff: "@@ -1,3 +1,3 @@\n # Agent memory\n-old behavior\n+preserve tool result evidence\n next step\n" }],
    ...(scenario === "paths" ? { file_changes_incomplete: true } : {}),
    result: { stdout: "Updated notes successfully.\n", stderr: "", interrupted: false },
  }),
};
const conversation = ConversationModel.fromSnapshot(localV2SnapshotSchema.parse({
  version: 2, store_generation: "fixture", snapshot_seq: 1,
  conversation: { conversation_id: "c", summary_seq: 1, provider: "claude", title: "Update notes", status: "idle", pinned: false, archived: false, updated_at: at },
  turns: [{ id: "t", turn_index: 0, request_id: "r", status: "completed", started_at: at, messages: [], events: [{ seq: 1, turn_id: "t", turn_seq: 1, item_id: "call", type: "item.completed", final: true, created_at: at, payload }] }],
}));
const messages = new CommittedConversationMessages(new TranscriptModel(), "workspace", "session", "en").update(conversation, "all");
const calls = projectWorkspaceAgentMessagesToTimelineItems(messages).filter((item) => item.callId).map((item) => projectAgentToolCall(toolCallView(item)));
createRoot(document.getElementById("root")!).render(<main style={{ padding: 24, maxWidth: 800, width: "100%", margin: "0 auto", background: "var(--background-primary)", color: "var(--foreground-primary)", minHeight: "100vh", overflow: "auto" }}>
  <h1 style={{ fontSize: "var(--text-title-sm)", marginBottom: 20 }}>Update agent memory notes</h1>
  <p style={{ marginBottom: 16 }}>{calls.length} tool call · Bash · Completed</p>
  {calls.map((call) => <AgentExpandedToolContent key={call.id} call={call} />)}
</main>);
