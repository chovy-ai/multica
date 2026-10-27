import { isLocalPermissionMode, type LocalPermissionMode } from "@multica/core/local-conversation/protocol";

export class PermissionPreferences {
  private values = new Map<string, LocalPermissionMode>();
  hydrate(raw: string | null) {
    if (!raw) return;
    try {
      const entries: unknown = JSON.parse(raw);
      if (Array.isArray(entries)) for (const entry of entries) {
        if (Array.isArray(entry) && typeof entry[0] === "string" && isLocalPermissionMode(entry[1])) this.values.set(entry[0], entry[1]);
      }
    } catch { /* Invalid saved preferences retain the provider's defaults. */ }
  }
  get(agentId: string, sessionId?: string | null) { return this.values.get(sessionId ? `session:${sessionId}` : `draft:${agentId}`); }
  set(agentId: string, sessionId: string | null | undefined, mode: LocalPermissionMode) {
    if (!isLocalPermissionMode(mode)) throw new Error("Invalid permission mode");
    this.values.set(sessionId ? `session:${sessionId}` : `draft:${agentId}`, mode);
  }
  serialize() { return JSON.stringify([...this.values]); }
}
