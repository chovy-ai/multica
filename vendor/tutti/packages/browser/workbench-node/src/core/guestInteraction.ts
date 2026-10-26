export const browserNodeGuestInteractionHostChannel =
  "browser-node:guest-interaction";

export type BrowserNodeGuestInteractionType =
  | "focusin"
  | "keydown"
  | "pointerdown";

export interface BrowserNodeGuestInteractionPayload {
  type: BrowserNodeGuestInteractionType;
}
