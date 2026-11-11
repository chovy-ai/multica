import { useEffect, type RefObject } from "react";

function isEditor(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        'input,textarea,select,[contenteditable]:not([contenteditable="false"]),.monaco-editor,.cm-editor'
      )
    )
  );
}

export function useAgentGUITimelineSelectAll(
  timelineRef: RefObject<HTMLDivElement | null>,
  enabled: boolean
): void {
  useEffect(() => {
    const timeline = timelineRef.current;
    if (!enabled || !timeline) return;
    const ownerDocument = timeline.ownerDocument;
    const selectAll = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.key.toLowerCase() !== "a" ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        isEditor(event.target) ||
        isEditor(ownerDocument.activeElement)
      ) return;

      const selection = ownerDocument.getSelection();
      if (!selection) return;
      // Non-focusable message text sends keys to the body. Its selection
      // identifies the owning timeline; a focused control takes precedence.
      const target = event.target;
      const neutralTarget =
        target === ownerDocument.body || target === ownerDocument.documentElement;
      const belongsToTimeline =
        target instanceof Node && timeline.contains(target);
      if (
        !belongsToTimeline &&
        !(neutralTarget && timeline.contains(selection.anchorNode))
      ) return;

      const range = ownerDocument.createRange();
      range.selectNodeContents(timeline);
      selection.removeAllRanges();
      selection.addRange(range);
      event.preventDefault();
    };
    ownerDocument.addEventListener("keydown", selectAll);
    return () => ownerDocument.removeEventListener("keydown", selectAll);
  }, [enabled, timelineRef]);
}
