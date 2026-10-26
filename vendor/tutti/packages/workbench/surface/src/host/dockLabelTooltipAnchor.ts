const dockLabelTooltipVisualSelector = [
  "[data-desktop-dock-icon-shell]",
  ".desktop-dock__minimized-preview",
  ".desktop-dock__minimized-stack-icon"
].join(", ");

export function resolveDockLabelTooltipAnchorRect(
  slotElement: HTMLElement
): Pick<DOMRect, "height" | "left" | "top" | "width"> {
  const visualElement = slotElement.querySelector<HTMLElement>(
    dockLabelTooltipVisualSelector
  );
  const anchorRect = (visualElement ?? slotElement).getBoundingClientRect();

  return {
    height: anchorRect.height,
    left: anchorRect.left,
    top: anchorRect.top,
    width: anchorRect.width
  };
}
