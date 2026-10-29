import { settingsHttpError } from "../shared/settings-operation-error";

export interface MulticaApiTarget { apiUrl: string; token: string; workspaceId: string }

/**
 * One authenticated workspace API call. Errors keep business details but redact
 * the credential; a write whose response cannot be read is reported as unconfirmed.
 */
export async function multicaWorkspaceRequest(target: MulticaApiTarget, method: string, path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
  const form = body instanceof FormData;
  const response = await fetch(`${target.apiUrl.replace(/\/+$/, "")}${path}`, {
    method, headers: { Authorization: `Bearer ${target.token}`, "X-Workspace-ID": target.workspaceId, ...(body !== undefined && !form ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: form ? body : JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(form ? 60000 : 15000)]),
  });
  if (!response.ok) {
    let error: unknown;
    try { error = await response.json(); } catch { /* An error response may have no JSON body. */ }
    throw settingsHttpError(response.status, error, target.token);
  }
  let value: unknown;
  try { value = response.status === 204 ? null : await response.json(); }
  catch { throw new Error("The server did not confirm the operation result. Inspect current state before repeating a write."); }
  signal.throwIfAborted();
  const next = response.headers.get("X-Agent-Tasks-Next-Cursor");
  return next && Array.isArray(value) ? { items: value, has_more: true, next_cursor: next } : value;
}
