import { useCallback, useSyncExternalStore, type RefObject } from "react";

/**
 * Whether the app window is actually in front of the user right now: the
 * document is visible (not a background browser tab / minimized window) AND the
 * window holds OS focus (not sitting behind another app or another window).
 *
 * Callers use it to answer "is the user really looking at this surface". A chat
 * reply that lands while the app is NOT in the foreground must not be
 * auto-marked-read and must still raise the unread badge — otherwise the
 * notification is silently eaten while the user is away (MUL-4485). The chat
 * sidebar badge and the auto mark-read effects share this signal so they stay
 * consistent: while backgrounded the active session both counts toward the
 * badge and keeps its unread; on return the badge clears and mark-read fires.
 *
 * In the browser the value is always measured from the real DOM. The `true`
 * fallbacks below only apply where there is no window to measure — SSR and
 * other non-DOM contexts — which also have no live surface or WS traffic to act
 * on. `true` (foreground) is chosen there only so the SSR snapshot matches the
 * first client snapshot of a freshly opened, focused window and hydration
 * doesn't flip the value; the real focus/visibility state takes over
 * immediately on the client, flipping to `false` the moment either is lost.
 */
function subscribe(onStoreChange: () => void, frameRef?: RefObject<HTMLIFrameElement | null>): () => void {
  if (typeof document === "undefined") return () => {};
  let settledFocus: ReturnType<typeof setTimeout> | undefined;
  const focusChanged = () => {
    onStoreChange();
    if (settledFocus !== undefined) clearTimeout(settledFocus);
    // Entering an iframe blurs the parent window before hasFocus settles.
    // Measure again after the transition, without treating blur as inactivity.
    settledFocus = setTimeout(() => { settledFocus = undefined; onStoreChange(); }, 0);
  };
  let releaseFrame = () => {};
  const observeFrame = () => {
    releaseFrame();
    releaseFrame = () => {};
    // Child focus events do not cross the iframe boundary. Always remeasure
    // the owning document so background frames cannot claim foreground state.
    try {
      const child = frameRef?.current?.contentWindow;
      const childDocument = frameRef?.current?.contentDocument;
      if (!child || !childDocument) return;
      child.addEventListener("focus", focusChanged, true);
      child.addEventListener("blur", focusChanged, true);
      childDocument.addEventListener("pointerdown", focusChanged, true);
      childDocument.addEventListener("keydown", focusChanged, true);
      releaseFrame = () => {
        child.removeEventListener("focus", focusChanged, true);
        child.removeEventListener("blur", focusChanged, true);
        childDocument.removeEventListener("pointerdown", focusChanged, true);
        childDocument.removeEventListener("keydown", focusChanged, true);
      };
    } catch {
      // Cross-origin frames cannot be observed; use the owning window events.
    }
  };
  const frameLoaded = (event: Event) => {
    if (event.target !== frameRef?.current) return;
    observeFrame();
    focusChanged();
  };
  if (frameRef) {
    observeFrame();
    document.addEventListener("load", frameLoaded, true);
  }
  document.addEventListener("visibilitychange", onStoreChange);
  window.addEventListener("focus", focusChanged, true);
  window.addEventListener("blur", focusChanged, true);
  return () => {
    releaseFrame();
    if (frameRef) document.removeEventListener("load", frameLoaded, true);
    if (settledFocus !== undefined) clearTimeout(settledFocus);
    document.removeEventListener("visibilitychange", onStoreChange);
    window.removeEventListener("focus", focusChanged, true);
    window.removeEventListener("blur", focusChanged, true);
  };
}

function getSnapshot(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState === "visible" && document.hasFocus();
}

// Server render has no window to be in the foreground of; default to visible so
// the first client paint matches SSR, then useSyncExternalStore reconciles to
// the real value on hydration.
function getServerSnapshot(): boolean {
  return true;
}

export function useAppForeground(frameRef?: RefObject<HTMLIFrameElement | null>): boolean {
  const subscribeToFocus = useCallback((onStoreChange: () => void) => subscribe(onStoreChange, frameRef), [frameRef]);
  return useSyncExternalStore(subscribeToFocus, getSnapshot, getServerSnapshot);
}
