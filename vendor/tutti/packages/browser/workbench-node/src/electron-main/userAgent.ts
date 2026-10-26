import type { WebContents } from "electron";
import type { BrowserNodeElectronLogger } from "./types.ts";

const electronUserAgentTokenPattern = /\sElectron\/[^\s]+/g;

export function sanitizeBrowserGuestUserAgent(userAgent: string): string {
  return userAgent
    .trim()
    .replace(electronUserAgentTokenPattern, "")
    .replace(/\s{2,}/g, " ");
}

export function applyBrowserGuestUserAgent(
  contents: WebContents,
  logger?: BrowserNodeElectronLogger
): void {
  const guestContents = contents as WebContents & {
    getUserAgent?: () => string;
    setUserAgent?: (userAgent: string) => void;
  };
  if (
    typeof guestContents.getUserAgent !== "function" ||
    typeof guestContents.setUserAgent !== "function"
  ) {
    return;
  }

  const currentUserAgent = guestContents.getUserAgent().trim();
  const nextUserAgent = sanitizeBrowserGuestUserAgent(currentUserAgent);
  if (!nextUserAgent || nextUserAgent === currentUserAgent) {
    return;
  }

  guestContents.setUserAgent(nextUserAgent);
  logger?.debug?.("Browser Node sanitized guest user agent", {
    webContentsId: contents.id ?? null
  });
}
