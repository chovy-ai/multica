import { z } from "zod";

/**
 * Wire messages between Desktop, the multica daemon and the local conversation
 * sidecar. The Go side declares the same shapes in
 * server/internal/daemon/localhost/protocol.go; both test suites decode the
 * shared fixtures in server/internal/daemon/localhost/testdata/protocol.
 */

export const LOCAL_HOST_API_VERSION = 1;
export const LOCAL_HOST_SIDECAR_PROTOCOL_VERSION = 2;

const scope = z.object({ apiUrl: z.string(), userId: z.string(), workspaceId: z.string() }).strict();
const env = z.record(z.string(), z.string());

export const SIDECAR_STATUSES = ["idle", "starting", "ready", "crashed", "draining", "unsupported"] as const;
/** Unknown statuses from a newer daemon read as "unknown" instead of failing the connection. */
const status = z.string().transform((value): (typeof SIDECAR_STATUSES)[number] | "unknown" => (SIDECAR_STATUSES as readonly string[]).includes(value) ? value as (typeof SIDECAR_STATUSES)[number] : "unknown");

export const rpcErrorSchema = z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() });

export const helloSchema = z.object({
  apiVersion: z.number(),
  sidecarProtocolVersion: z.number().default(0),
  capabilities: z.array(z.string()).default([]),
  sidecar: z.object({ status, instance: z.string().default(""), busy: z.number().default(0), crashes: z.number().default(0) }),
});

// Desktop → daemon.
export const sessionParamsSchema = z.object({ userId: z.string(), apiUrl: z.string(), env, legacyDataDir: z.string().optional() }).strict();
export const sessionResultSchema = z.object({ connectionId: z.string(), status, instance: z.string() });
export const subscribeParamsSchema = z.object({ since: z.string() }).strict();
export const subscribeResultSchema = z.object({ cursor: z.string(), resync: z.boolean() });
export const requestParamsSchema = z.object({ scope, method: z.string(), params: z.unknown() }).strict();
export const hostReplyParamsSchema = z.object({ id: z.string(), result: z.unknown().optional(), error: rpcErrorSchema.optional() }).strict();
export const drainResultSchema = z.object({ busy: z.number() });

// Daemon → Desktop.
export const eventNotificationSchema = z.object({ cursor: z.string(), event: z.unknown() });
export const hostRequestNotificationSchema = z.object({ id: z.string(), kind: z.string(), payload: z.unknown() });
export const hostRequestResolvedSchema = z.object({ id: z.string() });
export const sidecarStatusNotificationSchema = z.object({ status, instance: z.string() });
export const resyncNotificationSchema = z.object({ instance: z.string() });

// Daemon → sidecar.
export const initParamsSchema = z.object({ instance: z.string(), protocolVersion: z.number(), dataDir: z.string(), profileDir: z.string(), cliPath: z.string() }).strict();
export const sidecarSessionParamsSchema = z.object({ connectionId: z.string(), userId: z.string(), apiUrl: z.string(), env, legacyDataDir: z.string().optional() }).strict();
export const sidecarRequestParamsSchema = z.object({ connectionId: z.string(), scope, method: z.string(), params: z.unknown() }).strict();
export const fileResolveParamsSchema = z.object({ scope, fileRef: z.string() }).strict();
export const fileResolveResultSchema = z.object({ path: z.string(), mimeType: z.string(), name: z.string() }).strict();
export const fileCommitParamsSchema = z.object({ scope, tempPath: z.string(), name: z.string(), mimeType: z.string(), size: z.number() }).strict();
export const fileCommitResultSchema = z.object({ id: z.string() }).strict();

// Sidecar → daemon.
export const sidecarEventParamsSchema = z.object({ seq: z.number(), event: z.unknown() }).strict();
export const busyParamsSchema = z.object({ count: z.number() }).strict();
export const logParamsSchema = z.object({ level: z.string(), message: z.string(), fields: z.record(z.string(), z.unknown()).optional() }).strict();
export const hostRequestParamsSchema = z.object({ connectionId: z.string(), kind: z.string(), payload: z.unknown() }).strict();

/** Host request kinds Desktop knows how to serve. */
export const HOST_REQUEST_KINDS = ["confirmed_operation", "settings_host", "pick_directory", "pick_preview", "developer_logs_export", "side_workspace"] as const;
export type HostRequestKind = (typeof HOST_REQUEST_KINDS)[number];

export type LocalHostScope = z.infer<typeof scope>;
export type LocalHostHello = z.infer<typeof helloSchema>;
export type SidecarStatus = z.infer<typeof status>;
