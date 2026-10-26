export function publicSettingsValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicSettingsValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/(?:token|secret|password|credential|authorization|private_key|headers|^env$|mcp_config|runtime_config|custom_args|webhook_url|webhook_path)/i.test(key)).map(([key, entry]) => [key, publicSettingsValue(entry)]));
}

/** Preserve business errors and workflow plans without leaking response credentials. */
export class SettingsOperationError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown, readonly status?: number) { super(message); }
  toJSON() { return { code: this.code, message: this.message, ...(this.status ? { http_status: this.status } : {}), ...(this.details === undefined ? {} : { details: publicSettingsValue(this.details) }) }; }
}

export function settingsHttpError(status: number, raw: unknown, credential: string): SettingsOperationError {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const code = typeof value.code === "string" ? value.code.slice(0, 200) : `http_${status}`;
  const message = typeof value.error === "string" ? value.error : typeof value.message === "string" ? value.message : "Multica operation failed";
  const details = Object.fromEntries(["plan", "required", "unchanged", "total_issues", "affected_issues", "project_ids", "status_mapping"].filter((key) => key in value).map((key) => [key, value[key]]));
  const redact = (value: unknown): unknown => typeof value === "string" ? credential ? value.split(credential).join("[redacted]") : value : Array.isArray(value) ? value.map(redact) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)])) : value;
  return new SettingsOperationError(String(redact(code)), `Multica operation failed (HTTP ${status}). ${String(redact(message)).slice(0, 1000)}`, redact(details), status);
}
