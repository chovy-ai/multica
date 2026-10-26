"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { agentGuiMessageTargetOrigin, isAgentGuiFrameMessage } from "@multica/tutti-agent-gui-host/frame-messaging";

/** Promote the owning GUI frame without moving or recreating its browsing context. */
export function AgentGuiPreviewHost({ iframe, enabled, isCurrent, children }: {
  iframe: RefObject<HTMLIFrameElement | null>; enabled: boolean; isCurrent(): boolean; children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const current = useRef({ enabled, isCurrent }); current.current = { enabled, isCurrent };
  const close = useCallback(() => {
    setExpanded(false);
    iframe.current?.contentWindow?.postMessage({ type: "multica:agent-gui:preview-close", version: 1 }, agentGuiMessageTargetOrigin());
  }, [iframe]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!isAgentGuiFrameMessage(event, iframe.current?.contentWindow ?? null) || !current.current.isCurrent()) return;
      const value = event.data;
      if (value?.type !== "multica:agent-gui:preview-state" || value.version !== 1 || typeof value.expanded !== "boolean") return;
      if (value.expanded && !current.current.enabled) return;
      setExpanded(value.expanded);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [iframe]);
  useEffect(() => { if (!enabled || !isCurrent()) close(); }, [enabled, isCurrent, close]);
  useLayoutEffect(() => {
    const surface = dialog.current;
    if (expanded && surface && !surface.open) { surface.showModal(); iframe.current?.focus({ preventScroll: true }); }
    else if (!expanded && surface?.open) surface.close();
  }, [expanded, iframe]);
  useEffect(() => {
    const surface = dialog.current;
    return () => { if (surface?.open) surface.close(); };
  }, []);
  return <dialog ref={dialog} role={expanded ? "dialog" : "presentation"} aria-label={expanded ? "SVG" : undefined} data-testid="agent-gui-global-preview"
    onLoadCapture={(event) => { if (event.target === iframe.current) close(); }}
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); close(); }}
    className="relative m-0 flex h-full min-h-0 w-full max-w-none flex-1 flex-col border-0 bg-transparent p-0 text-inherit open:fixed open:inset-0 open:m-0 open:h-dvh open:max-h-none open:w-screen open:overflow-hidden backdrop:bg-transparent">
    {children}
  </dialog>;
}
