import { z } from "zod";
import type { DeveloperLogQuery } from "../shared/developer-logs";
import type { WorkspaceMcpTool } from "./local-workspace-tools";

/**
 * The export_developer_logs MCP tool. `run` performs the export wherever the
 * logs live: in Desktop directly, or from the sidecar through a host request.
 */
export function developerLogTool(run: (query: DeveloperLogQuery, signal: AbortSignal) => Promise<unknown>, currentConversationId?: string): WorkspaceMcpTool {
  const requests = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
  const inputSchema = {
    scope: z.enum(["conversation", "workspace"]).default("conversation"),
    conversation_id: z.string().regex(/^[\w:.-]{1,160}$/).optional(),
    since_minutes: z.number().int().min(1).max(10080).default(60),
    request_id: z.string().trim().min(1).max(128),
  };
  return {
    name: "export_developer_logs",
    description: "Export developer diagnostics together in one private JSON file: scoped conversation stage timings, this account's Web renderer console, runtime versions and the current desktop profile's daemon log tail. Conversation/workspace and since_minutes filter timings; Web logs use the same time range across the account, and daemon logs are a bounded profile-wide tail without a time/conversation filter. Defaults to this conversation and 60 minutes. No cloud login required. Returns the local path, per-source availability/truncation and counts; read with a native file tool. Common credentials, URLs and payload fields are scrubbed, but diagnostic text may contain private details: review before sharing, and never upload without the user's request. Reuse request_id on retries. Auto exports are kept up to 7 days, at most 20 files.",
    inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async call(raw, signal) {
      const input = z.object(inputSchema).strict().parse(raw);
      if (input.scope === "workspace" && input.conversation_id) throw new Error("Omit conversation_id for a workspace export");
      const conversationId = input.scope === "conversation" ? input.conversation_id ?? currentConversationId : undefined;
      if (input.scope === "conversation" && !conversationId) throw new Error("Supply a local conversation_id or choose scope=workspace");
      const query = { sinceMinutes: input.since_minutes, ...(conversationId ? { conversationId } : {}) };
      const fingerprint = JSON.stringify(query);
      const previous = requests.get(input.request_id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error("This request_id already belongs to another log export");
        return previous.result;
      }
      if (requests.size >= 20) throw new Error("Too many log exports in this execution");
      const result = run(query, signal);
      requests.set(input.request_id, { fingerprint, result });
      return result;
    },
  };
}
