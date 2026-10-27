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
