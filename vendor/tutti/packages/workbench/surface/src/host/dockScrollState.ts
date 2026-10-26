export interface WorkbenchHostDockScrollState {
  canScrollBackward: boolean;
  canScrollForward: boolean;
  hasOverflow: boolean;
}

export interface ResolveWorkbenchHostDockScrollStateInput {
  contentSize: number;
  scrollOffset: number;
  scrollSize: number;
  viewportSize: number;
}

const dockScrollOverflowEpsilonPx = 1;

export function resolveWorkbenchHostDockScrollState({
  contentSize,
  scrollOffset,
  scrollSize,
  viewportSize
}: ResolveWorkbenchHostDockScrollStateInput): WorkbenchHostDockScrollState {
  const hasOverflow = contentSize > viewportSize + dockScrollOverflowEpsilonPx;
  if (!hasOverflow) {
    return {
      canScrollBackward: false,
      canScrollForward: false,
      hasOverflow: false
    };
  }

  const maxScrollOffset = Math.max(
    0,
    Math.max(scrollSize, contentSize) - viewportSize
  );

  return {
    canScrollBackward: scrollOffset > dockScrollOverflowEpsilonPx,
    canScrollForward:
      scrollOffset < maxScrollOffset - dockScrollOverflowEpsilonPx,
    hasOverflow
  };
}
