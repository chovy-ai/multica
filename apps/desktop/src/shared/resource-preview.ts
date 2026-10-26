import type { LocalConversationScope } from "@multica/tutti-agent-gui-host/local-protocol";
export interface WebPreviewState { id: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; error?: string }
export interface WebPreviewCommand { id: string; action: "show" | "hide" | "close" | "navigate" | "back" | "forward" | "reload"; url?: string; bounds?: { x: number; y: number; width: number; height: number } }
export interface ResourcePreviewClient {
  request(scope: LocalConversationScope, command: WebPreviewCommand): Promise<WebPreviewState | null>;
  subscribe(listener: (state: WebPreviewState) => void): () => void;
}
