import type { SettingsScope, SettingsRequest } from "@multica/core/settings/operations";
import { SettingsOperationError } from "../shared/settings-operation-error";

export interface SettingsHostRequest { operation: string; scope: SettingsScope; input: Record<string, unknown> }
export type SettingsConfirmRequest = SettingsHostRequest & { impact?: unknown };
export type SettingsApplyOutcome = { approved: false } | { approved: true; raw: unknown };
/**
 * Asks a human and, only on approval, performs `apply` on the host side, so
 * the caller can never turn a forged approval into a write. `apply` is null
 * for host-only operations, which the caller runs through `host` afterwards.
 */
export type ConfirmAndApply = (request: SettingsConfirmRequest, apply: SettingsRequest | null, signal: AbortSignal) => Promise<SettingsApplyOutcome>;
/**
 * Host-side composition of ConfirmAndApply. A created token's secret is shown
 * to the human and stripped from the result, so it never reaches the agent.
 */
export function confirmThenApply(parts: {
  confirm(request: SettingsConfirmRequest, signal: AbortSignal): Promise<boolean>;
  request(request: SettingsRequest, signal: AbortSignal, scope: SettingsScope): Promise<unknown>;
  showSecret?: (name: string, secret: string, scope: SettingsScope, signal: AbortSignal) => Promise<void>;
}): ConfirmAndApply {
  return async (request, apply, signal) => {
    if (!await parts.confirm(request, signal)) return { approved: false };
    signal.throwIfAborted();
    if (!apply) return { approved: true, raw: null };
    const raw = await parts.request(apply, signal, request.scope);
    if (request.operation !== "settings_create_token") return { approved: true, raw };
    const result = object(raw);
    if (typeof result.token !== "string" || !result.token) throw new SettingsOperationError("result_unconfirmed", "The server did not confirm token creation");
    if (!parts.showSecret) throw new SettingsOperationError("secret_display_unavailable", "The token was created but could not be displayed. Revoke it in Settings; do not create another token automatically.");
    await parts.showSecret(String(request.input.name), result.token, request.scope, signal);
    return { approved: true, raw: { id: result.id ?? null } };
  };
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
