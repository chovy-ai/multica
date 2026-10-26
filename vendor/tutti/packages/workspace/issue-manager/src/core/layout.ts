export const issueManagerSidebarDefaultWidth = 280;
export const issueManagerSidebarMinWidth = 248;
export const issueManagerSidebarMaxWidth = 520;
export const issueManagerMainMinWidth = 420;
export const issueManagerDefaultNodeFrameWidth = 860;
export const issueManagerExpandedFrameMinWidth =
  issueManagerSidebarMinWidth + issueManagerMainMinWidth;

export function clampIssueManagerSidebarWidth(
  width: number,
  layoutWidth: number
): number {
  const maxWidth = Math.max(
    issueManagerSidebarMinWidth,
    Math.min(
      issueManagerSidebarMaxWidth,
      layoutWidth - issueManagerMainMinWidth
    )
  );
  return Math.min(Math.max(width, issueManagerSidebarMinWidth), maxWidth);
}

export function shouldAutoCollapseIssueManagerSidebar(
  containerWidth: number
): boolean {
  return (
    Number.isFinite(containerWidth) &&
    containerWidth > 0 &&
    Math.round(containerWidth) < issueManagerExpandedFrameMinWidth
  );
}

export function resolveIssueManagerExpandedFrame<
  TFrame extends { width: number; x: number }
>(frame: TFrame, surfaceWidth: number): TFrame {
  const preferredWidth = Math.max(
    issueManagerExpandedFrameMinWidth,
    Math.min(
      issueManagerDefaultNodeFrameWidth,
      frame.width + issueManagerSidebarDefaultWidth
    )
  );
  const width = Math.min(
    Math.max(frame.width, preferredWidth),
    Math.max(frame.width, surfaceWidth)
  );

  return {
    ...frame,
    width,
    x: Math.max(0, Math.min(frame.x, surfaceWidth - width))
  };
}
