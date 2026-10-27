import { z } from "zod";
import type { LocalConversationScope } from "@multica/core/local-conversation/protocol";

export interface DeveloperLogQuery {
  sinceMinutes: number;
  conversationId?: string;
}

export type DeveloperLogSaveResult =
  | { status: "saved"; filename: string; recordCount: number }
  | { status: "cancelled" };

export interface DeveloperLogsClient {
  export(scope: LocalConversationScope): Promise<DeveloperLogSaveResult>;
}

/** Validates a log export query that arrives from the conversation host. */
export const developerLogQuerySchema = z.object({
  sinceMinutes: z.number().int().min(1).max(10080),
  conversationId: z.string().regex(/^[\w:.-]{1,160}$/).optional(),
}).strict();
