import { z } from "zod";

/**
 * Local conversation protocol v2 between Desktop and the Go daemon
 * (`/local/v2`). The definition source is
 * server/internal/localconversation/protocol/schema/local-v2.schema.json;
 * these schemas decode the same golden samples. They accept unknown event
 * types and enum values from a newer daemon: callers skip what they do not
 * understand instead of failing the connection.
 */

export const LOCAL_V2_VERSION = 2;

const nullableString = z.string().nullable().optional().transform((value) => value ?? null);
const payload = z.record(z.string(), z.unknown());

export const localV2EventSchema = z.object({
  seq: z.number().int().positive(),
  turn_id: nullableString,
  turn_seq: z.number().int().nullable().optional().transform((value) => value ?? null),
  item_id: nullableString,
  type: z.string(),
  final: z.boolean(),
  created_at: z.string(),
  payload,
});
export type LocalV2Event = z.infer<typeof localV2EventSchema>;

export const localV2SummarySchema = z.object({
  conversation_id: z.string(),
  summary_seq: z.number().int(),
  provider: z.string(),
  title: z.string(),
  status: z.string(),
  cwd: z.string().default(""),
  project_id: nullableString,
  pinned: z.boolean(),
  archived: z.boolean(),
  last_message_preview: z.string().default(""),
  pending_interactions: z.number().int().default(0),
  queue_count: z.number().int().default(0),
  side_source_id: z.string().optional(),
  side_source_turn_id: z.string().optional(),
  side_quote: z.string().optional(),
  updated_at: z.string(),
});
export type LocalV2Summary = z.infer<typeof localV2SummarySchema>;

const errorSchema = z.object({ kind: z.string(), message: z.string() });

export const localV2ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    version: z.literal(LOCAL_V2_VERSION), type: z.literal("conversation.events"), conversation_id: z.string(),
    from_seq: z.number().int(), to_seq: z.number().int(), events: z.array(localV2EventSchema).min(1),
  }),
  z.object({ version: z.literal(LOCAL_V2_VERSION), type: z.literal("scope.summaries"), scope_seq: z.number().int(), summaries: z.array(localV2SummarySchema) }),
  z.object({
    version: z.literal(LOCAL_V2_VERSION), type: z.literal("subscription.status"), conversation_id: z.string().optional(),
    status: z.string(), high_water: z.number().int().optional(), error: errorSchema.optional(),
  }),
  z.object({ version: z.literal(LOCAL_V2_VERSION), type: z.literal("host.request"), request_id: z.string(), kind: z.string(), payload }),
]);
export type LocalV2ServerMessage = z.infer<typeof localV2ServerMessageSchema>;

export const localV2ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ version: z.literal(LOCAL_V2_VERSION), type: z.literal("subscribe_scope"), after_scope_seq: z.number().int().min(0).optional(), store_generation: z.string().optional() }).strict(),
  z.object({ version: z.literal(LOCAL_V2_VERSION), type: z.literal("subscribe"), conversation_id: z.string(), after_seq: z.number().int().min(0), store_generation: z.string() }).strict(),
  z.object({ version: z.literal(LOCAL_V2_VERSION), type: z.literal("unsubscribe"), conversation_id: z.string() }).strict(),
  z.object({ version: z.literal(LOCAL_V2_VERSION), type: z.literal("host.reply"), request_id: z.string(), result: z.unknown().optional(), error: errorSchema.optional() }).strict(),
]);
export type LocalV2ClientMessage = z.infer<typeof localV2ClientMessageSchema>;

export const localV2HelloSchema = z.object({
  version: z.number().int(),
  store_generation: z.string(),
  capabilities: z.array(z.string()).default([]),
});

const snapshotMessageSchema = z.object({
  id: z.string(), role: z.string(), content: z.string(),
  attachment_ids: z.array(z.string()).nullable().default([]).transform((value) => value ?? []),
  steered: z.boolean().default(false), failed: z.boolean().default(false), created_at: z.string(),
});

const snapshotTurnSchema = z.object({
  id: z.string(), turn_index: z.number().int(), request_id: z.string().default(""), status: z.string(),
  started_at: z.string(), completed_at: z.string().optional(), error: errorSchema.optional(),
  messages: z.array(snapshotMessageSchema), events: z.array(localV2EventSchema),
});
export type LocalV2SnapshotTurn = z.infer<typeof snapshotTurnSchema>;

export const localV2SnapshotSchema = z.object({
  version: z.number().int(),
  store_generation: z.string(),
  snapshot_seq: z.number().int(),
  conversation: localV2SummarySchema,
  turns: z.array(snapshotTurnSchema),
  has_older_turns: z.boolean().default(false),
  pending_interactions: z.array(z.object({
    interaction_id: z.string(), turn_id: z.string(), kind: z.string(), request: payload, created_at: z.string(),
  })).default([]),
});
export type LocalV2Snapshot = z.infer<typeof localV2SnapshotSchema>;

export const localV2SessionListSchema = z.object({
  scope_seq: z.number().int(),
  summaries: z.array(localV2SummarySchema),
  has_more: z.boolean().default(false),
});

export const localV2ErrorSchema = z.object({ error: errorSchema });

export interface LocalV2Scope { userId: string; workspaceId: string }

/**
 * Desktop's v2 transport as the renderer sees it: the main process keeps
 * the daemon token and one WebSocket per scope.
 */
export interface LocalV2Transport {
  /** A JSON request to `/local/v2{path}`. */
  request(scope: LocalV2Scope, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown>;
  /** Sends a client message on the scope's WebSocket. */
  send(scope: LocalV2Scope, message: LocalV2ClientMessage): Promise<void>;
  /** Receives the scope's server messages. */
  subscribe(listener: (scope: LocalV2Scope, message: unknown) => void): () => void;
  /** Receives connection changes; subscriptions are lost on disconnect. */
  onConnection(listener: (scope: LocalV2Scope, connected: boolean) => void): () => void;
  /** A URL streaming a daemon file: an attachment, a conversation image or preview content. */
  fileUrl(scope: LocalV2Scope, path: string): string;
  /** Uploads a message attachment. */
  upload(scope: LocalV2Scope, file: File): Promise<LocalV2Upload>;
}

export const localV2UploadSchema = z.object({ id: z.string(), name: z.string(), mime_type: z.string(), size: z.number() });
export type LocalV2Upload = z.infer<typeof localV2UploadSchema>;

/** Daemon file routes the renderer may stream. */
export function isLocalV2FilePath(path: string): boolean {
  return /^\/attachments\/[\w-]{1,128}$/.test(path) || /^\/sessions\/[\w:.~-]{1,160}\/image\?path=/.test(path) || /^\/preview\/content\?/.test(path);
}
