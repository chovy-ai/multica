import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { resolveNextWindowRect } from "./placement";
import {
  appendWindowToStack,
  focusWindowInStack,
  removeWindowFromStack,
  replaceWindowStack,
  resolveFullscreenRect,
  resolveLowerRightAnchoredRect,
  resolveQuickLayoutRect
} from "./windowController";
import type {
  DesktopSize,
  DesktopStore,
  OpenWindowParams,
  WindowQuickLayoutTarget,
  WindowRect,
  WindowState
} from "./types";
import type { RuntimeDiagnosticsDetailValue } from "../../shared/contracts/dto";
import { getOptionalAgentHostApi } from "../../agentActivityHost";

const DEFAULT_DESKTOP_SIZE: DesktopSize = { width: 1280, height: 720 };
const WEBSITE_WINDOW_MISSING_GRACE_MS = 250;
const pendingWebsiteWindowRemovalTimersById = new Map<
  string,
  ReturnType<typeof globalThis.setTimeout>
>();

function logDesktopStoreDiagnostics(payload: {
  event: string;
  message: string;
  details: Record<string, RuntimeDiagnosticsDetailValue>;
}): void {
  getOptionalAgentHostApi()?.debug?.logRuntimeDiagnostics?.({
    source: "renderer-workspace-surface",
    level: "info",
    event: payload.event,
    message: payload.message,
    details: payload.details
  });
}

function formatDiagnosticIds(ids: readonly string[]): string {
  return ids.join(",");
}

function formatDiagnosticWindows(windows: readonly WindowState[]): string {
  return windows.map((window) => `${window.id}:${window.kind}`).join(",");
}

function cancelPendingWebsiteWindowRemoval(id: string, reason: string): void {
  const timerId = pendingWebsiteWindowRemovalTimersById.get(id);
  if (timerId === undefined) {
    return;
  }

  globalThis.clearTimeout(timerId);
  pendingWebsiteWindowRemovalTimersById.delete(id);
  logDesktopStoreDiagnostics({
    event: "desktop-window-retention-canceled",
    // i18n-check-ignore: Internal diagnostic log message.
    message: "Canceled pending website window retention cleanup.",
    details: {
      nodeId: id,
      reason
    }
  });
}

function schedulePendingWebsiteWindowRemoval(id: string): void {
  if (pendingWebsiteWindowRemovalTimersById.has(id)) {
    return;
  }

  logDesktopStoreDiagnostics({
    event: "desktop-window-retention-started",
    message:
      "Retaining a missing website window briefly to absorb transient node list gaps.",
    details: {
      nodeId: id,
      delayMs: WEBSITE_WINDOW_MISSING_GRACE_MS
    }
  });
  const timerId = globalThis.setTimeout(() => {
    pendingWebsiteWindowRemovalTimersById.delete(id);
    useDesktopStore.setState((state) => ({
      windows: state.windows.filter((window) => window.id !== id),
      windowStack: removeWindowFromStack(state.windowStack, id)
    }));
    logDesktopStoreDiagnostics({
      event: "desktop-window-retention-expired",
      message:
        "Dropped a retained website window after the grace window elapsed.",
      details: {
        nodeId: id
      }
    });
  }, WEBSITE_WINDOW_MISSING_GRACE_MS);
  pendingWebsiteWindowRemovalTimersById.set(id, timerId);
}

function focusWindows(
  windows: readonly WindowState[],
  id: string
): WindowState[] {
  return windows.map((window) => {
    const isTarget = window.id === id;
    const nextIsFocused = isTarget;
    const nextIsMinimized = isTarget ? false : window.isMinimized;
    const nextMinimizedAt = isTarget ? null : (window.minimizedAt ?? null);
    if (
      window.isFocused === nextIsFocused &&
      window.isMinimized === nextIsMinimized &&
      (window.minimizedAt ?? null) === nextMinimizedAt
    ) {
      return window;
    }
    return {
      ...window,
      isFocused: nextIsFocused,
      isMinimized: nextIsMinimized,
      minimizedAt: nextMinimizedAt
    };
  });
}

function projectFocusedWindow(
  windows: readonly WindowState[],
  windowStack: readonly string[]
) {
  const frontId = windowStack.at(-1) ?? null;
  return windows.map((window) => {
    const nextIsFocused = window.id === frontId && !window.isMinimized;
    if (window.isFocused === nextIsFocused) {
      return window;
    }
    return { ...window, isFocused: nextIsFocused };
  });
}

function windowRectEquals(left: WindowRect, right: WindowRect): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function stringArrayEquals(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function equivalentRecord(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        equivalentValue(left[key], right[key])
    )
  );
}

function equivalentValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (typeof left !== typeof right || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equivalentValue(value, right[index]))
    );
  }
  if (typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  return equivalentRecord(
    left as Record<string, unknown>,
    right as Record<string, unknown>
  );
}

function windowStateEquals(left: WindowState, right: WindowState): boolean {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.title === right.title &&
    windowRectEquals(left.rect, right.rect) &&
    left.displayMode === right.displayMode &&
    ((left.restoreRect === null && right.restoreRect === null) ||
      (left.restoreRect !== null &&
        right.restoreRect !== null &&
        windowRectEquals(left.restoreRect, right.restoreRect))) &&
    left.isMinimized === right.isMinimized &&
    (left.minimizedAt ?? null) === (right.minimizedAt ?? null) &&
    (left.previewImageUrl ?? null) === (right.previewImageUrl ?? null) &&
    left.isFocused === right.isFocused &&
    equivalentValue(left.data, right.data)
  );
}

function orderWindowsByStableDomPosition(
  previousWindows: readonly WindowState[],
  nextWindows: readonly WindowState[]
): WindowState[] {
  const nextWindowById = new Map(
    nextWindows.map((window) => [window.id, window])
  );
  const ordered: WindowState[] = [];

  for (const previousWindow of previousWindows) {
    const nextWindow = nextWindowById.get(previousWindow.id);
    if (!nextWindow) {
      continue;
    }
    ordered.push(nextWindow);
    nextWindowById.delete(previousWindow.id);
  }

  for (const nextWindow of nextWindows) {
    if (nextWindowById.has(nextWindow.id)) {
      ordered.push(nextWindow);
      nextWindowById.delete(nextWindow.id);
    }
  }

  return ordered;
}

export const useDesktopStore = create<DesktopStore>((set, get) => ({
  windows: [],
  windowStack: [],
  activeDragWindowId: null,
  activeSnapTarget: null,
  layoutSmoothWindowId: null,

  beginLayoutSmoothTransition(id) {
    set({ layoutSmoothWindowId: id });
  },

  clearLayoutSmoothTransition() {
    set({ layoutSmoothWindowId: null });
  },

  replaceWindows(windows) {
    set((state) => {
      const incomingIds = windows.map((window) => window.id);
      logDesktopStoreDiagnostics({
        event: "desktop-window-replace-received",
        // i18n-check-ignore: Internal diagnostic log message.
        message: "Received a desktop window replacement payload.",
        details: {
          incomingWindowIds: formatDiagnosticIds(incomingIds),
          incomingWindows: formatDiagnosticWindows(windows),
          incomingWindowCount: incomingIds.length,
          existingWindowIds: formatDiagnosticIds(
            state.windows.map((window) => window.id)
          ),
          existingWindows: formatDiagnosticWindows(state.windows),
          existingWindowCount: state.windows.length
        }
      });

      const currentById = new Map(
        state.windows.map((window) => [window.id, window])
      );
      const incomingIdSet = new Set(incomingIds);
      const nextWindows = windows.map((window) => {
        cancelPendingWebsiteWindowRemoval(window.id, "window-present");
        const current = currentById.get(window.id);
        if (!current) {
          return window;
        }

        return {
          ...window,
          rect: current.rect,
          displayMode: current.displayMode,
          restoreRect: current.restoreRect,
          isMinimized: current.isMinimized,
          minimizedAt: current.minimizedAt ?? null,
          isFocused: current.isFocused,
          previewImageUrl: current.previewImageUrl
        };
      });
      const retainedWebsiteWindows = state.windows.filter((window) => {
        if (incomingIdSet.has(window.id) || window.kind !== "website") {
          return false;
        }
        schedulePendingWebsiteWindowRemoval(window.id);
        return true;
      });
      const mergedWindows = orderWindowsByStableDomPosition(state.windows, [
        ...nextWindows,
        ...retainedWebsiteWindows
      ]);
      const windowStack = replaceWindowStack(
        state.windowStack,
        mergedWindows.map((window) => window.id)
      );
      const focusedWindows = projectFocusedWindow(mergedWindows, windowStack);

      if (
        stringArrayEquals(state.windowStack, windowStack) &&
        state.windows.length === focusedWindows.length &&
        state.windows.every((window, index) => {
          const focusedWindow = focusedWindows[index];
          return Boolean(
            focusedWindow && windowStateEquals(window, focusedWindow)
          );
        })
      ) {
        logDesktopStoreDiagnostics({
          event: "desktop-window-replace-noop",
          message:
            "Skipped desktop window replacement because the merged runtime state was unchanged.",
          details: {
            incomingWindowIds: formatDiagnosticIds(incomingIds),
            incomingWindows: formatDiagnosticWindows(windows),
            retainedWebsiteWindowIds: formatDiagnosticIds(
              retainedWebsiteWindows.map((window) => window.id)
            ),
            mergedWindowIds: formatDiagnosticIds(
              focusedWindows.map((window) => window.id)
            ),
            mergedWindows: formatDiagnosticWindows(focusedWindows),
            windowStack: formatDiagnosticIds(windowStack)
          }
        });
        return state;
      }

      logDesktopStoreDiagnostics({
        event: "desktop-window-replace-applied",
        // i18n-check-ignore: Internal diagnostic log message.
        message: "Applied desktop window replacement to the runtime store.",
        details: {
          incomingWindowIds: formatDiagnosticIds(incomingIds),
          incomingWindows: formatDiagnosticWindows(windows),
          retainedWebsiteWindowIds: formatDiagnosticIds(
            retainedWebsiteWindows.map((window) => window.id)
          ),
          mergedWindowIds: formatDiagnosticIds(
            focusedWindows.map((window) => window.id)
          ),
          mergedWindows: formatDiagnosticWindows(focusedWindows),
          previousWindowStack: formatDiagnosticIds(state.windowStack),
          nextWindowStack: formatDiagnosticIds(windowStack)
        }
      });
      return {
        windows: focusedWindows,
        windowStack
      };
    });
  },

  openWindow(params: OpenWindowParams, desktopSize = DEFAULT_DESKTOP_SIZE) {
    cancelPendingWebsiteWindowRemoval(params.id, "open-window");
    const state = get();
    const preferredWidth = params.rect?.width ?? params.data.width ?? 720;
    const preferredHeight = params.rect?.height ?? params.data.height ?? 460;
    const frontWindowId = state.windowStack.at(-1);
    const frontWindow = state.windows.find(
      (window) => window.id === frontWindowId
    );
    const rect =
      typeof params.rect?.x === "number" ||
      typeof params.rect?.y === "number" ||
      !frontWindow
        ? resolveNextWindowRect({
            existingWindows: state.windows,
            desktopSize,
            preferredRect: {
              ...params.rect,
              width: preferredWidth,
              height: preferredHeight
            }
          })
        : resolveLowerRightAnchoredRect({
            anchor: frontWindow.rect,
            desktopSize,
            width: preferredWidth,
            height: preferredHeight
          });
    const window: WindowState = {
      id: params.id,
      kind: params.kind,
      title: params.title,
      rect,
      displayMode: "floating",
      restoreRect: null,
      isMinimized: false,
      minimizedAt: null,
      isFocused: true,
      previewImageUrl: null,
      data: {
        ...params.data,
        width: rect.width,
        height: rect.height
      }
    };

    const windowStack = focusWindowInStack(
      appendWindowToStack(state.windowStack, window.id),
      window.id
    );
    set({
      windows: [
        ...state.windows.map((candidate) => ({
          ...candidate,
          isFocused: false
        })),
        window
      ],
      windowStack
    });

    return window;
  },

  closeWindow(id) {
    cancelPendingWebsiteWindowRemoval(id, "close-window");
    set((state) => ({
      windows: state.windows.filter((window) => window.id !== id),
      windowStack: removeWindowFromStack(state.windowStack, id)
    }));
  },

  focusWindow(id) {
    cancelPendingWebsiteWindowRemoval(id, "focus-window");
    const state = get();
    if (!state.windows.some((window) => window.id === id)) {
      logDesktopStoreDiagnostics({
        event: "desktop-window-focus-ignored-missing",
        message:
          "Ignored a focus request because the target window was not present in the desktop store.",
        details: {
          nodeId: id,
          windowIds: formatDiagnosticIds(
            state.windows.map((window) => window.id)
          )
        }
      });
      return;
    }
    if (
      state.windowStack.at(-1) === id &&
      state.windows.every((window) =>
        window.id === id
          ? window.isFocused && !window.isMinimized
          : !window.isFocused
      )
    ) {
      logDesktopStoreDiagnostics({
        event: "desktop-window-focus-noop",
        message:
          "Skipped focus update because the target window was already frontmost and focused.",
        details: {
          nodeId: id,
          windowStack: formatDiagnosticIds(state.windowStack)
        }
      });
      return;
    }

    const windowStack = focusWindowInStack(state.windowStack, id);
    logDesktopStoreDiagnostics({
      event: "desktop-window-focus-applied",
      // i18n-check-ignore: Internal diagnostic log message.
      message: "Applied a focus update to the desktop store.",
      details: {
        nodeId: id,
        previousWindowStack: formatDiagnosticIds(state.windowStack),
        nextWindowStack: formatDiagnosticIds(windowStack)
      }
    });
    set({
      windows: focusWindows(state.windows, id),
      windowStack
    });
  },

  minimizeWindow(id) {
    set((state) => ({
      windows: state.windows.map((window) =>
        window.id === id
          ? {
              ...window,
              isMinimized: true,
              minimizedAt: Date.now(),
              isFocused: false
            }
          : window
      )
    }));
  },

  enterFullscreenWindow(id, desktopSize) {
    const state = get();
    const windowStack = focusWindowInStack(state.windowStack, id);
    set({
      windowStack,
      windows: state.windows.map((window) =>
        window.id === id
          ? {
              ...window,
              restoreRect:
                window.displayMode === "fullscreen"
                  ? window.restoreRect
                  : window.rect,
              rect: resolveFullscreenRect(desktopSize),
              displayMode: "fullscreen",
              isFocused: true,
              isMinimized: false,
              minimizedAt: null
            }
          : { ...window, isFocused: false }
      )
    });
  },

  exitFullscreenWindow(id) {
    const state = get();
    const target = state.windows.find((window) => window.id === id);
    if (!target || target.displayMode !== "fullscreen") {
      return;
    }

    const windowStack = focusWindowInStack(state.windowStack, id);
    set({
      windowStack,
      windows: state.windows.map((window) =>
        window.id === id
          ? {
              ...window,
              rect: window.restoreRect ?? window.rect,
              restoreRect: null,
              displayMode: "floating",
              isFocused: true,
              isMinimized: false,
              minimizedAt: null
            }
          : { ...window, isFocused: false }
      )
    });
  },

  toggleFullscreenWindow(id, desktopSize) {
    const target = get().windows.find((window) => window.id === id);
    if (target?.displayMode === "fullscreen") {
      get().exitFullscreenWindow(id, desktopSize);
      return;
    }
    get().enterFullscreenWindow(id, desktopSize);
  },

  applyQuickLayout(id, target: WindowQuickLayoutTarget, desktopSize) {
    const state = get();
    if (!state.windows.some((window) => window.id === id)) {
      return;
    }

    const windowStack = focusWindowInStack(state.windowStack, id);
    const rect = resolveQuickLayoutRect(target, desktopSize);
    set({
      windowStack,
      windows: state.windows.map((window) =>
        window.id === id
          ? {
              ...window,
              rect,
              displayMode: "floating",
              restoreRect: null,
              isFocused: true,
              isMinimized: false,
              minimizedAt: null,
              data: {
                ...window.data,
                width: rect.width,
                height: rect.height
              }
            }
          : { ...window, isFocused: false }
      )
    });
  },

  restoreWindow(id) {
    const target = get().windows.find((window) => window.id === id);
    if (!target) {
      return;
    }

    if (target.isMinimized) {
      get().focusWindow(id);
      return;
    }

    if (target.displayMode === "fullscreen") {
      get().exitFullscreenWindow(id);
    }
  },

  setWindowPreviewImage(id, previewImageUrl) {
    set((state) => {
      const target = state.windows.find((window) => window.id === id);
      if (!target || target.previewImageUrl === previewImageUrl) {
        return state;
      }

      return {
        windows: state.windows.map((window) =>
          window.id === id ? { ...window, previewImageUrl } : window
        )
      };
    });
  },

  setDraggingWindow(id) {
    set((state) => {
      if (state.activeDragWindowId === id) {
        return state;
      }
      return {
        activeDragWindowId: id,
        ...(id !== null ? { layoutSmoothWindowId: null } : {})
      };
    });
  },

  setActiveSnapTarget(target) {
    set((state) =>
      state.activeSnapTarget === target ? state : { activeSnapTarget: target }
    );
  },

  moveWindow(id, x, y) {
    set((state) => {
      const target = state.windows.find((window) => window.id === id);
      if (
        !target ||
        target.displayMode === "fullscreen" ||
        (target.rect.x === x && target.rect.y === y)
      ) {
        return state;
      }

      return {
        windows: state.windows.map((window) =>
          window.id === id
            ? { ...window, rect: { ...window.rect, x, y } }
            : window
        )
      };
    });
  },

  resizeWindow(id, rect: Partial<WindowRect>) {
    set((state) => {
      const target = state.windows.find((window) => window.id === id);
      if (!target) {
        return state;
      }

      const nextRect = { ...target.rect, ...rect };
      const nextDataWidth = rect.width ?? target.data.width;
      const nextDataHeight = rect.height ?? target.data.height;
      if (
        windowRectEquals(target.rect, nextRect) &&
        target.data.width === nextDataWidth &&
        target.data.height === nextDataHeight
      ) {
        return state;
      }

      return {
        windows: state.windows.map((window) =>
          window.id === id
            ? {
                ...window,
                rect: nextRect,
                data: {
                  ...window.data,
                  width: nextDataWidth,
                  height: nextDataHeight
                }
              }
            : window
        )
      };
    });
  },

  updateWindowData(id, patch) {
    set((state) => ({
      windows: state.windows.map((window) =>
        window.id === id
          ? { ...window, data: { ...window.data, ...patch } }
          : window
      )
    }));
  },

  updateWindowTitle(id, title) {
    set((state) => ({
      windows: state.windows.map((window) =>
        window.id === id
          ? { ...window, title, data: { ...window.data, title } }
          : window
      )
    }));
  }
}));

export function useDesktopSnapshot() {
  return useDesktopStore(
    useShallow((state) => ({
      windows: state.windows,
      windowStack: state.windowStack,
      activeDragWindowId: state.activeDragWindowId
    }))
  );
}

export function useDesktopActions() {
  return useDesktopStore(
    useShallow((state) => ({
      beginLayoutSmoothTransition: state.beginLayoutSmoothTransition,
      clearLayoutSmoothTransition: state.clearLayoutSmoothTransition,
      replaceWindows: state.replaceWindows,
      openWindow: state.openWindow,
      closeWindow: state.closeWindow,
      minimizeWindow: state.minimizeWindow,
      restoreWindow: state.restoreWindow,
      focusWindow: state.focusWindow,
      resizeWindow: state.resizeWindow,
      moveWindow: state.moveWindow,
      enterFullscreenWindow: state.enterFullscreenWindow,
      exitFullscreenWindow: state.exitFullscreenWindow,
      applyQuickLayout: state.applyQuickLayout,
      setDraggingWindow: state.setDraggingWindow,
      setActiveSnapTarget: state.setActiveSnapTarget
    }))
  );
}
