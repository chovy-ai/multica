import { z } from "zod";
import type { SideWorkspaceSnapshot } from "@multica/core/local-conversation/protocol";

const id = z.string().min(1).max(160);
export const browserActionSchema = z.object({
  type: z.enum(["snapshot", "screenshot", "click", "type", "press", "scroll", "select", "navigate", "wait"]),
  ref: z.string().max(200).optional(), x: z.number().finite().optional(), y: z.number().finite().optional(),
  text: z.string().max(100_000).optional(), key: z.string().max(80).optional(), value: z.string().max(4096).optional(),
  url: z.string().max(8192).optional(), direction: z.enum(["back", "forward", "reload"]).optional(),
  dy: z.number().finite().optional(), button: z.enum(["left", "right", "middle"]).optional(), double: z.boolean().optional(),
  clear: z.boolean().optional(), submit: z.boolean().optional(), fullPage: z.boolean().optional(),
  load: z.boolean().optional(), timeoutMs: z.number().int().min(1).max(30_000).optional(),
}).strict();
export const sideWorkspaceControlSchema = z.object({
  op: z.enum(["open", "select", "close", "browser", "release"]),
  scope: z.object({ userId: id, workspaceId: id }).strict(), conversationId: id,
  turnId: id.optional(), tabId: id.optional(), requestId: id.optional(), select: z.boolean().optional(),
  // Set by main for another device's conversation: "local" or absent is this device.
  deviceId: z.string().min(1).max(200).optional(),
  keep: z.boolean().optional(),
  tab: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("web"), url: z.string().max(8192) }).strict(),
    z.object({ kind: z.literal("side"), sessionId: id }).strict(),
    z.object({ kind: z.literal("file"), path: z.string().min(1).max(4096) }).strict(),
  ]).optional(),
  action: browserActionSchema.optional(),
}).strict();
export type BrowserAction = z.infer<typeof browserActionSchema>;
export type SideWorkspaceControlRequest = z.infer<typeof sideWorkspaceControlSchema>;
export interface SideWorkspaceCommand { id: string; request: SideWorkspaceControlRequest }
export const sideWorkspaceAckSchema = z.object({ id, snapshot: z.unknown().optional(), tabId: id.optional(), error: z.string().max(4096).optional() }).strict();
export interface SideWorkspaceAck { id: string; snapshot?: SideWorkspaceSnapshot; tabId?: string; error?: string }
export interface SideWorkspaceClient {
  onCommand(listener: (command: SideWorkspaceCommand) => void): () => void;
  ack(reply: SideWorkspaceAck): Promise<void>;
  /** Makes the Side browser follow the layout the daemon stored for a conversation. */
  reconcile(scope: { userId: string; workspaceId: string }, conversationId: string, deviceId: string): Promise<void>;
  onActivity(listener: (activity: { conversationId: string; tabId: string; turnId?: string; active: boolean }) => void): () => void;
}
