import {
  browserNodeGuestInteractionHostChannel,
  type BrowserNodeGuestInteractionPayload,
  type BrowserNodeGuestInteractionType
} from "../core/guestInteraction.ts";

export type {
  BrowserNodeGuestInteractionPayload,
  BrowserNodeGuestInteractionType
};

export function installBrowserNodeGuestInteractionForwarding({
  scope,
  sendToHost
}: {
  scope: Window;
  sendToHost: (
    channel: string,
    payload: BrowserNodeGuestInteractionPayload
  ) => void;
}): () => void {
  const document = scope.document;
  const records: Array<{
    listener: EventListener;
    type: BrowserNodeGuestInteractionType;
  }> = [];

  for (const type of ["pointerdown", "focusin", "keydown"] as const) {
    const listener: EventListener = () => {
      sendToHost(browserNodeGuestInteractionHostChannel, { type });
    };
    records.push({ listener, type });
    document.addEventListener(type, listener, {
      capture: true,
      passive: true
    });
  }

  return () => {
    for (const record of records) {
      document.removeEventListener(record.type, record.listener, {
        capture: true
      });
    }
  };
}
