import type { LocalConversationScope } from "@multica/core/local-conversation/protocol";

export interface LocalFileContextMenuInput {
  sessionId: string;
  url: string;
  hasSelection: boolean;
}

export interface LocalFileContextMenuClient {
  /** deviceId names another device whose conversation the file belongs to. */
  show(scope: LocalConversationScope, input: LocalFileContextMenuInput, deviceId?: string): Promise<void>;
}
