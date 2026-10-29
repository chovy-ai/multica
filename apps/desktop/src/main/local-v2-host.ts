import { z } from "zod";
import type { LocalConversationScope } from "@multica/core/local-conversation/protocol";
import type { SettingsRequest } from "@multica/core/settings/operations";
import { developerLogQuerySchema, type DeveloperLogQuery } from "../shared/developer-logs";
import { SettingsOperationError } from "../shared/settings-operation-error";
import type { SettingsConfirmRequest, SettingsHostRequest, SettingsApplyOutcome } from "../local-host/local-settings-tools";

export interface LocalV2HostHandlers {
  /** The signed-in account; requests for another account are refused. */
  currentUser(): string | null | undefined;
  side(request: unknown, signal: AbortSignal): Promise<unknown>;
  confirm(request: SettingsConfirmRequest, apply: SettingsRequest | null, signal: AbortSignal): Promise<SettingsApplyOutcome>;
  settingsHost(request: SettingsHostRequest, signal: AbortSignal): Promise<unknown>;
  developerLogs(scope: LocalConversationScope, query: DeveloperLogQuery, signal: AbortSignal): Promise<unknown>;
}

const daemonScope = z.object({ workspace_id: z.string(), user_id: z.string() });
const settingsPayload = z.object({ operation: z.string().regex(/^settings_[a-z_]+$/), scope: daemonScope, input: z.record(z.string(), z.unknown()), impact: z.unknown().optional(),
  apply: z.object({ method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]), path: z.string().startsWith("/api/"), body: z.unknown().optional() }).optional() });

const HOST_TIMEOUT_MS = 90_000;

/**
 * Performs the daemon's v2 host requests with Desktop's existing handlers.
 * Every request must name the account and workspace of the socket it
 * arrived on, and that account must still be signed in.
 */
export function localV2HostHandler(handlers: LocalV2HostHandlers) {
  return async (scope: LocalConversationScope, kind: string, payload: Record<string, unknown>): Promise<unknown> => {
    if (handlers.currentUser() !== scope.userId) throw new SettingsOperationError("settings_host_unavailable", "Open the main app with the same signed-in account to continue");
    const signal = AbortSignal.timeout(HOST_TIMEOUT_MS);
    const settings = () => {
      const value = settingsPayload.parse(payload);
      if (value.scope.user_id !== scope.userId || value.scope.workspace_id !== scope.workspaceId) throw new SettingsOperationError("workspace_mismatch", "The request belongs to another account or workspace");
      return { ...value, scope: { userId: scope.userId, workspaceId: scope.workspaceId } };
    };
    switch (kind) {
      case "settings.confirm": {
        const { apply, ...request } = settings();
        return handlers.confirm(request, (apply ?? null) as SettingsRequest | null, signal);
      }
      case "settings.host": {
        const { operation, scope: requestScope, input } = settings();
        return handlers.settingsHost({ operation, scope: requestScope, input }, signal);
      }
      case "settings.refresh":
        return handlers.settingsHost({ operation: "settings_refresh", scope, input: {} }, signal);
      case "side.control": {
        const target = (payload.scope ?? {}) as { userId?: unknown; workspaceId?: unknown };
        if (target.userId !== scope.userId || target.workspaceId !== scope.workspaceId) throw new SettingsOperationError("workspace_mismatch", "The request belongs to another account or workspace");
        return handlers.side(payload, signal);
      }
      case "developer_logs.export":
        return handlers.developerLogs(scope, developerLogQuerySchema.parse(payload), signal);
    }
    throw new SettingsOperationError("unsupported_host_request", `Desktop cannot handle ${kind}`);
  };
}
