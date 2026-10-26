import { useEffect, useRef, type RefObject } from "react";

interface MentionPaginationState {
  status: string;
  query: string;
  filter: string;
  groups: readonly {
    id: string;
    visibleCount: number;
    hasMore: boolean;
    expandStatus?: string;
  }[];
}

/** Reuse the palette controller's pagination without changing selection or editor focus. */
export function useMentionScrollPagination(
  scrollRef: RefObject<HTMLDivElement | null>,
  state: MentionPaginationState,
  onExpandGroup: (groupId: string) => void,
): void {
  const requestedPages = useRef(new Set<string>());
  const scope = JSON.stringify([state.filter, state.query]);
  useEffect(() => { requestedPages.current.clear(); }, [scope]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    let frame: number | undefined;
    const check = () => {
      frame = undefined;
      if (state.status === "loading" || state.status === "error") return;
      const viewport = scroll.getBoundingClientRect();
      if (viewport.height <= 0) return;
      for (const marker of scroll.querySelectorAll<HTMLElement>("[data-load-more-group]")) {
        const group = state.groups.find((entry) => entry.id === marker.dataset.loadMoreGroup);
        if (!group?.hasMore || group.expandStatus === "loading" || group.expandStatus === "error") continue;
        const page = JSON.stringify([group.id, group.visibleCount]);
        if (requestedPages.current.has(page)) continue;
        const bounds = marker.getBoundingClientRect();
        if (bounds.bottom < viewport.top || bounds.top > viewport.bottom + 48) continue;
        // Reserve before dispatch: repeated scroll events can arrive before React updates loading state.
        requestedPages.current.add(page);
        onExpandGroup(group.id);
        return;
      }
    };
    const schedule = () => { frame ??= requestAnimationFrame(check); };
    scroll.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      scroll.removeEventListener("scroll", schedule);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [scrollRef, state, onExpandGroup, scope]);
}
