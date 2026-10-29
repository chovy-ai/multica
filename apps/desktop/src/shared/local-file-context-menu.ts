import type { LocalConversationScope } from "@multica/core/local-conversation/protocol";

export interface LocalFileContextMenuInput {
  sessionId: string;
  url: string;
  hasSelection: boolean;
}

export interface LocalFileContextMenuClient {
  show(scope: LocalConversationScope, input: LocalFileContextMenuInput): Promise<void>;
}
