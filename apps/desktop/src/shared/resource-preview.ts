import type { LocalConversationScope } from "@multica/core/local-conversation/protocol";
export interface WebPreviewState { id: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; error?: string }
export interface WebPreviewCommand { id: string; action: "show" | "hide" | "close" | "navigate" | "back" | "forward" | "reload"; url?: string; bounds?: { x: number; y: number; width: number; height: number } }
export interface ResourcePreviewClient {
  request(scope: LocalConversationScope, command: WebPreviewCommand): Promise<WebPreviewState | null>;
  subscribe(listener: (state: WebPreviewState) => void): () => void;
  listChromeProfiles(scope: LocalConversationScope): Promise<ChromeProfileList>;
  importChromeProfile(scope: LocalConversationScope, input: ChromeProfileImportInput): Promise<ChromeProfileImportResult>;
  cancelChromeProfileImport(scope: LocalConversationScope, requestId: string): Promise<boolean>;
}

export interface ChromeProfile { id: string; name: string; email?: string }
export type ChromeProfileList =
  | { status: "available"; profiles: ChromeProfile[] }
  | { status: "unavailable"; reason: "unsupported-platform" | "no-profiles" | "unavailable" };
export interface ChromeProfileImportInput { id: string; profileId: string; requestId: string }
export interface ChromeProfileImportResult {
  status: "success" | "partial" | "empty" | "failed" | "canceled";
  imported: number;
  skipped: number;
  failed: number;
  code?: string;
}
