export const CONTEXT_MENU_ITEM_HEIGHT_PX = 32;
export const CONTEXT_MENU_PADDING_PX = 8;
export const CONTEXT_MENU_SUBMENU_GAP_PX = 4;
export const CONTEXT_MENU_VIEWPORT_PADDING_PX = 12;
export const OPEN_WITH_SUBMENU_WIDTH_PX = 220;

export type OpenWithSubmenuPlacementMode = "right" | "left" | "overlay";

export interface OpenWithSubmenuPlacement {
  left: number;
  mode: OpenWithSubmenuPlacementMode;
  top: number;
  width: number;
}

export function resolveOpenWithSubmenuPlacement(input: {
  gap?: number;
  overlayHeaderHeight?: number;
  padding?: number;
  parentMenuLeft: number;
  parentMenuTop: number;
  submenuHeight: number;
  submenuWidth?: number;
  triggerLeft: number;
  triggerRight: number;
  triggerTop: number;
  viewportHeight: number;
  viewportWidth: number;
}): OpenWithSubmenuPlacement {
  const gap = input.gap ?? CONTEXT_MENU_SUBMENU_GAP_PX;
  const padding = input.padding ?? CONTEXT_MENU_VIEWPORT_PADDING_PX;
  const availableWidth = Math.max(0, input.viewportWidth - padding * 2);
  const width = Math.min(
    input.submenuWidth ?? OPEN_WITH_SUBMENU_WIDTH_PX,
    availableWidth
  );
  const rightLeft = input.triggerRight + gap;
  const leftLeft = input.triggerLeft - gap - width;
  const rightFits = rightLeft + width <= input.viewportWidth - padding;
  const leftFits = leftLeft >= padding;
  const mode: OpenWithSubmenuPlacementMode = rightFits
    ? "right"
    : leftFits
      ? "left"
      : "overlay";
  const rawLeft =
    mode === "right"
      ? rightLeft
      : mode === "left"
        ? leftLeft
        : input.parentMenuLeft;
  const rawTop = mode === "overlay" ? input.parentMenuTop : input.triggerTop;
  const overlayHeaderHeight =
    mode === "overlay"
      ? (input.overlayHeaderHeight ?? CONTEXT_MENU_ITEM_HEIGHT_PX)
      : 0;
  const availableHeight = Math.max(0, input.viewportHeight - padding * 2);
  const height = Math.min(
    Math.max(0, input.submenuHeight + overlayHeaderHeight),
    availableHeight
  );
  const maxLeft = Math.max(padding, input.viewportWidth - padding - width);
  const maxTop = Math.max(padding, input.viewportHeight - padding - height);

  return {
    left: Math.max(padding, Math.min(rawLeft, maxLeft)),
    mode,
    top: Math.max(padding, Math.min(rawTop, maxTop)),
    width
  };
}

export function clampContextMenuPosition(input: {
  boundaryHeight: number;
  boundaryWidth: number;
  menuHeight: number;
  menuWidth: number;
  padding?: number;
  x: number;
  y: number;
}): { x: number; y: number } {
  const padding = input.padding ?? CONTEXT_MENU_PADDING_PX;
  const maxX = Math.max(
    padding,
    input.boundaryWidth - input.menuWidth - padding
  );
  const maxY = Math.max(
    padding,
    input.boundaryHeight - input.menuHeight - padding
  );

  return {
    x: Math.min(Math.max(input.x, padding), maxX),
    y: Math.min(Math.max(input.y, padding), maxY)
  };
}

export function estimateOpenWithSubmenuHeight(input: {
  applicationCount: number;
  isLoading: boolean;
  showExternalSection: boolean;
  showOpenInAppBrowser: boolean;
  showOpenInDefaultBrowser: boolean;
  showOpenInFileViewer?: boolean;
  showOpenWithOther: boolean;
}): number {
  let itemCount = 0;

  if (input.showOpenInFileViewer) {
    itemCount += 1;
  }
  if (input.showOpenInAppBrowser) {
    itemCount += 1;
  }
  if (shouldShowOpenWithSectionDivider(input)) {
    itemCount += 1;
  }
  if (input.isLoading) {
    itemCount += 1;
  }
  itemCount += input.applicationCount;
  if (input.showOpenInDefaultBrowser) {
    itemCount += 1;
  }
  if (input.showOpenWithOther) {
    itemCount += 2;
  }

  return itemCount * CONTEXT_MENU_ITEM_HEIGHT_PX + CONTEXT_MENU_PADDING_PX * 2;
}

export function shouldShowOpenWithSectionDivider(input: {
  showExternalSection: boolean;
  showOpenInAppBrowser: boolean;
  showOpenInFileViewer?: boolean;
}): boolean {
  return (
    input.showExternalSection &&
    (input.showOpenInFileViewer === true || input.showOpenInAppBrowser)
  );
}
