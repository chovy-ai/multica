export class ModelPreferences {
  private values = new Map<string, string | null>();

  hydrate(raw: string | null) {
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const entry of parsed) {
        if (Array.isArray(entry) && typeof entry[0] === "string" && (entry[1] === null || validModel(entry[1]))) this.values.set(entry[0], entry[1]);
      }
    } catch { /* A damaged local preference must not block conversation history. */ }
  }

  get(agentId: string, sessionId?: string | null): string | null {
    return this.values.get(this.key(agentId, sessionId)) ?? null;
  }
  has(agentId: string, sessionId?: string | null): boolean {
    return this.values.has(this.key(agentId, sessionId));
  }

  set(agentId: string, sessionId: string | null | undefined, model: string | null) {
    if (model !== null && !validModel(model)) throw new Error("Invalid model ID");
    this.values.set(this.key(agentId, sessionId), model);
  }

  serialize() { return JSON.stringify([...this.values]); }

  private key(agentId: string, sessionId?: string | null) {
    return sessionId ? `session:${sessionId}` : `draft:${agentId}`;
  }
}

function validModel(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0
    && new TextEncoder().encode(value).length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
}
