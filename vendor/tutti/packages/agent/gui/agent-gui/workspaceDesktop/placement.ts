import {
  DESKTOP_DOCK_HEIGHT,
  DESKTOP_WINDOW_CASCADE_OFFSET,
  DESKTOP_WINDOW_EDGE_MARGIN,
  DESKTOP_WINDOW_MIN_HEIGHT,
  DESKTOP_WINDOW_MIN_WIDTH,
  DESKTOP_WINDOW_TOP_MARGIN
} from "./constants";
import type { DesktopSize, WindowRect, WindowState } from "./types";

const DEFAULT_WINDOW_WIDTH = 720;
const DEFAULT_WINDOW_HEIGHT = 460;
export const DESKTOP_WINDOW_MIN_VISIBLE_PX = 40;

export function resolveDesktopBottomInset(desktopSize: DesktopSize): number {
  return Math.max(
    DESKTOP_DOCK_HEIGHT,
    Math.round(desktopSize.bottomInset ?? DESKTOP_DOCK_HEIGHT)
  );
}

function availableHeight(desktopSize: DesktopSize): number {
  return Math.max(
    DESKTOP_WINDOW_MIN_HEIGHT,
    desktopSize.height -
      resolveDesktopBottomInset(desktopSize) -
      DESKTOP_WINDOW_TOP_MARGIN
  );
}

export function clampWindowRect(
  rect: WindowRect,
  desktopSize: DesktopSize
): WindowRect {
  const width = Math.max(
    DESKTOP_WINDOW_MIN_WIDTH,
    Math.min(rect.width, desktopSize.width)
  );
  const height = Math.max(
    DESKTOP_WINDOW_MIN_HEIGHT,
    Math.min(rect.height, availableHeight(desktopSize))
  );
  const maxX = Math.max(
    DESKTOP_WINDOW_EDGE_MARGIN,
    desktopSize.width - width - DESKTOP_WINDOW_EDGE_MARGIN
  );
  const maxY = Math.max(
    DESKTOP_WINDOW_TOP_MARGIN + DESKTOP_WINDOW_EDGE_MARGIN,
    DESKTOP_WINDOW_TOP_MARGIN +
      availableHeight(desktopSize) -
      height -
      DESKTOP_WINDOW_EDGE_MARGIN
  );

  return {
    x: Math.round(Math.min(Math.max(DESKTOP_WINDOW_EDGE_MARGIN, rect.x), maxX)),
    y: Math.round(
      Math.min(
        Math.max(
          DESKTOP_WINDOW_TOP_MARGIN + DESKTOP_WINDOW_EDGE_MARGIN,
          rect.y
        ),
        maxY
      )
    ),
    width: Math.round(width),
    height: Math.round(height)
  };
}

export function clampWindowRectToVisibleArea(
  rect: WindowRect,
  desktopSize: DesktopSize,
  minVisiblePx = DESKTOP_WINDOW_MIN_VISIBLE_PX
): WindowRect {
  const normalized = clampWindowRect(
    { ...rect, x: 0, y: DESKTOP_WINDOW_TOP_MARGIN },
    desktopSize
  );
  const minVisibleX = Math.min(minVisiblePx, desktopSize.width);
  const minVisibleY = Math.min(minVisiblePx, availableHeight(desktopSize));
  const minX = minVisibleX - normalized.width;
  const maxX = desktopSize.width - minVisibleX;
  // Keep the draggable header reachable even when legacy/persisted rects overflow the workspace bounds.
  const minY = DESKTOP_WINDOW_TOP_MARGIN;
  const maxY =
    DESKTOP_WINDOW_TOP_MARGIN + availableHeight(desktopSize) - minVisibleY;

  return {
    ...normalized,
    x: Math.round(Math.min(Math.max(minX, rect.x), maxX)),
    y: Math.round(Math.min(Math.max(minY, rect.y), maxY))
  };
}

export function clampWindowDragRect(
  rect: WindowRect,
  desktopSize: DesktopSize
): WindowRect {
  const visibleRect = clampWindowRectToVisibleArea(rect, desktopSize);

  return {
    ...visibleRect,
    y: Math.max(DESKTOP_WINDOW_TOP_MARGIN, visibleRect.y)
  };
}

export function centerWindowRect(
  desktopSize: DesktopSize,
  preferred?: Partial<Pick<WindowRect, "width" | "height">>
): WindowRect {
  const width =
    preferred?.width ??
    Math.min(
      DEFAULT_WINDOW_WIDTH,
      desktopSize.width - DESKTOP_WINDOW_EDGE_MARGIN * 2
    );
  const height =
    preferred?.height ??
    Math.min(
      DEFAULT_WINDOW_HEIGHT,
      availableHeight(desktopSize) - DESKTOP_WINDOW_EDGE_MARGIN * 2
    );

  return clampWindowRect(
    {
      x: (desktopSize.width - width) / 2,
      y:
        DESKTOP_WINDOW_TOP_MARGIN + (availableHeight(desktopSize) - height) / 2,
      width,
      height
    },
    desktopSize
  );
}

export function resolveNextWindowRect({
  existingWindows,
  desktopSize,
  preferredRect
}: {
  existingWindows: readonly WindowState[];
  desktopSize: DesktopSize;
  preferredRect?: Partial<WindowRect>;
}): WindowRect {
  const width = preferredRect?.width ?? DEFAULT_WINDOW_WIDTH;
  const height = preferredRect?.height ?? DEFAULT_WINDOW_HEIGHT;

  if (
    typeof preferredRect?.x === "number" &&
    typeof preferredRect.y === "number"
  ) {
    return clampWindowRect(
      { x: preferredRect.x, y: preferredRect.y, width, height },
      desktopSize
    );
  }

  if (existingWindows.length === 0) {
    return centerWindowRect(desktopSize, { width, height });
  }

  const topWindow = existingWindows.at(-1);
  const cascadeBase =
    topWindow?.rect ?? centerWindowRect(desktopSize, { width, height });
  return clampWindowRect(
    {
      x: cascadeBase.x + DESKTOP_WINDOW_CASCADE_OFFSET,
      y: cascadeBase.y + DESKTOP_WINDOW_CASCADE_OFFSET,
      width,
      height
    },
    desktopSize
  );
}

export function resolveMaximizedRect(desktopSize: DesktopSize): WindowRect {
  return {
    x: 0,
    y: DESKTOP_WINDOW_TOP_MARGIN,
    width: Math.max(DESKTOP_WINDOW_MIN_WIDTH, desktopSize.width),
    height: availableHeight(desktopSize)
  };
}
