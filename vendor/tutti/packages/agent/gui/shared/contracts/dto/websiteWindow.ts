export type WebsiteWindowSessionMode = "shared" | "incognito" | "profile";

export type WebsiteWindowLifecycle = "active" | "cold";

export interface SetWebsiteWindowOccludedInput {
  occluded: boolean;
}

export interface ActivateWebsiteWindowInput {
  nodeId: string;
  url: string;
  sessionMode: WebsiteWindowSessionMode;
  profileId: string | null;
}

export interface PrepareWebsiteWindowSessionInput {
  nodeId: string;
  sessionMode: WebsiteWindowSessionMode;
  profileId: string | null;
}

export interface RegisterWebsiteWindowGuestInput {
  nodeId: string;
  webContentsId: number;
  sessionMode: WebsiteWindowSessionMode;
  profileId: string | null;
}

export interface WebsiteWindowGuestOpenUrlInput {
  url: string;
}

export interface UnregisterWebsiteWindowGuestInput {
  nodeId: string;
  webContentsId: number;
}

export interface NavigateWebsiteWindowInput {
  nodeId: string;
  url: string;
}

export interface WebsiteWindowNodeIdInput {
  nodeId: string;
}

export interface SetWebsiteWindowDebugConsoleEnabledInput {
  enabled: boolean;
}

export interface WebsiteWindowDebugDump {
  nodeId: string;
  lifecycle: WebsiteWindowLifecycle;
  desiredUrl: string;
  currentUrl: string | null;
  title: string | null;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  sessionMode: WebsiteWindowSessionMode;
  profileId: string | null;
  hasView: boolean;
  isVisible: boolean | null;
  webContentsId: number | null;
  webContentsDestroyed: boolean | null;
  webContentsIsLoading: boolean | null;
  zoomFactor: number | null;
}

export interface WebsiteWindowStateEvent {
  type: "state";
  nodeId: string;
  lifecycle: WebsiteWindowLifecycle;
  isOccluded: boolean;
  /**
   * Main-process best-effort attachment hint for renderer diagnostics/state.
   * This does not prove the embedded guest is currently visible on screen.
   */
  isAttachedToWindow?: boolean;
  url: string | null;
  title: string | null;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface WebsiteWindowClosedEvent {
  type: "closed";
  nodeId: string;
}

export interface WebsiteWindowErrorEvent {
  type: "error";
  nodeId: string;
  message: string;
}

export interface WebsiteWindowOpenUrlEvent {
  type: "open-url";
  sourceNodeId: string;
  url: string;
  reuseIfOpen?: boolean;
  presentation?: "browser" | "template-app";
  appId?: string;
  templateId?: string;
  title?: string;
}

export type WebsiteWindowEventPayload =
  | WebsiteWindowStateEvent
  | WebsiteWindowClosedEvent
  | WebsiteWindowErrorEvent
  | WebsiteWindowOpenUrlEvent;
