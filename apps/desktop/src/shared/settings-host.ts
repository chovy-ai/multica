import type { SettingsScope } from "@multica/core/settings/operations";

export interface SettingsHostMessage { id: string; operation: string; scope: SettingsScope; input: Record<string, unknown> }
export interface SettingsHostReply { id: string; ok: boolean; result?: unknown; error?: string }
export interface SettingsHostClient {
  subscribe(listener: (request: SettingsHostMessage) => void): () => void;
  respond(reply: SettingsHostReply): Promise<void>;
}
