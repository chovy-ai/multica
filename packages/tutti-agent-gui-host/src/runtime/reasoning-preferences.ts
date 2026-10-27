import { isLocalReasoningEffort, type LocalReasoningEffort } from "../local-protocol";

interface Selection { model: string | null; effort: LocalReasoningEffort | null }
export class ReasoningPreferences {
  private values = new Map<string, Selection>();
  hydrate(raw: string | null) {
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const entry of parsed) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
        const value = entry[1];
        if (value && (value.model === null || typeof value.model === "string") && (value.effort === null || isLocalReasoningEffort(value.effort))) this.values.set(entry[0], value);
      }
    } catch { /* Damaged preferences must not block conversation history. */ }
  }
  get(agentId: string, sessionId?: string | null) { return this.values.get(this.key(agentId, sessionId)); }
  set(agentId: string, sessionId: string | null | undefined, model: string | null, effort: LocalReasoningEffort | null) {
    this.values.set(this.key(agentId, sessionId), { model, effort });
  }
  serialize() { return JSON.stringify([...this.values]); }
  private key(agentId: string, sessionId?: string | null) { return sessionId ? `session:${sessionId}` : `draft:${agentId}`; }
}
