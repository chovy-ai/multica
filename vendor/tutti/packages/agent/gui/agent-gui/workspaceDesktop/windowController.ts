import {
  DESKTOP_WINDOW_BASE_Z_INDEX,
  DESKTOP_WINDOW_CASCADE_OFFSET,
  DESKTOP_WINDOW_MIN_HEIGHT,
  DESKTOP_WINDOW_MIN_WIDTH,
  DESKTOP_WINDOW_TOP_MARGIN
} from "./constants";
import { clampWindowRect, resolveDesktopBottomInset } from "./placement";
import type { DesktopSize, WindowQuickLayoutTarget, WindowRect } from "./types";

export function resolveWindowLayoutFrame(desktopSize: DesktopSize): WindowRect {
  return {
    x: 0,
    y: DESKTOP_WINDOW_TOP_MARGIN,
    width: Math.max(DESKTOP_WINDOW_MIN_WIDTH, desktopSize.width),
    height: Math.max(
      DESKTOP_WINDOW_MIN_HEIGHT,
      desktopSize.height -
        resolveDesktopBottomInset(desktopSize) -
        DESKTOP_WINDOW_TOP_MARGIN
    )
  };
}

export function resolveQuickLayoutRect(
  target: WindowQuickLayoutTarget,
  desktopSize: DesktopSize
): WindowRect {
  const frame = resolveWindowLayoutFrame(desktopSize);

  switch (target) {
    case "left":
      return {
        ...frame,
        width: Math.round(frame.width / 4)
      };
    case "right": {
      const width = Math.round(frame.width / 4);
      return {
        ...frame,
        x: frame.x + frame.width - width,
        width
      };
    }
    case "top":
      return {
        ...frame,
        height: Math.round(frame.height / 2)
      };
    case "bottom": {
      const height = Math.round(frame.height / 2);
      return {
        ...frame,
        y: frame.y + frame.height - height,
        height
      };
    }
  }
}

export function resolveFullscreenRect(desktopSize: DesktopSize): WindowRect {
  return {
    x: 0,
    y: DESKTOP_WINDOW_TOP_MARGIN,
    width: Math.max(DESKTOP_WINDOW_MIN_WIDTH, desktopSize.width),
    height: Math.max(
      DESKTOP_WINDOW_MIN_HEIGHT,
      desktopSize.height - DESKTOP_WINDOW_TOP_MARGIN
    )
  };
}

export function resolveLowerRightAnchoredRect({
  anchor,
  desktopSize,
  width,
  height
}: {
  anchor: WindowRect;
  desktopSize: DesktopSize;
  width: number;
  height: number;
}): WindowRect {
  return clampWindowRect(
    {
      x: anchor.x + DESKTOP_WINDOW_CASCADE_OFFSET,
      y: anchor.y + DESKTOP_WINDOW_CASCADE_OFFSET,
      width,
      height
    },
    desktopSize
  );
}

export function appendWindowToStack(
  stack: readonly string[],
  id: string
): string[] {
  return stack.includes(id) ? [...stack] : [...stack, id];
}

export function focusWindowInStack(
  stack: readonly string[],
  id: string
): string[] {
  if (!stack.includes(id)) {
    return appendWindowToStack(stack, id);
  }

  return [...stack.filter((windowId) => windowId !== id), id];
}

export function removeWindowFromStack(
  stack: readonly string[],
  id: string
): string[] {
  return stack.filter((windowId) => windowId !== id);
}

export function replaceWindowStack(
  stack: readonly string[],
  nextIds: readonly string[]
): string[] {
  const nextIdSet = new Set(nextIds);
  const existing = stack.filter((id) => nextIdSet.has(id));
  const existingSet = new Set(existing);
  const appended = nextIds.filter((id) => !existingSet.has(id));

  return [...existing, ...appended];
}

export function deriveWindowZIndex(
  stack: readonly string[],
  id: string,
  baseZIndex = DESKTOP_WINDOW_BASE_Z_INDEX
): number {
  const index = stack.indexOf(id);

  return baseZIndex + Math.max(0, index);
}
