import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppForeground } from "./use-app-foreground";

/** Drive jsdom's visibility + focus, then fire the event the hook listens on. */
function setEnv(visible: boolean, focused: boolean) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (visible ? "visible" : "hidden"),
  });
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
});

describe("useAppForeground", () => {
  it("remeasures focus when the user returns directly into the conversation iframe", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const frameRef = { current: frame };
    setEnv(true, false);
    const { result, unmount } = renderHook(() => useAppForeground(frameRef));
    expect(result.current).toBe(false);

    act(() => {
      setEnv(true, true);
      frame.contentDocument!.dispatchEvent(new Event("pointerdown"));
    });
    expect(result.current).toBe(true);

    act(() => {
      setEnv(true, false);
      frame.contentWindow!.dispatchEvent(new Event("blur"));
    });
    expect(result.current).toBe(false);
    act(() => {
      frame.contentDocument!.dispatchEvent(new Event("keydown"));
    });
    expect(result.current).toBe(false);
    act(() => {
      setEnv(false, true);
      frame.contentWindow!.dispatchEvent(new Event("focus"));
    });
    expect(result.current).toBe(false);
    unmount();
    frame.remove();
  });

  it("observes a replaced iframe after load and releases its listeners on unmount", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const frameRef = { current: frame };
    setEnv(true, false);
    const { result, unmount } = renderHook(() => useAppForeground(frameRef));
    const replacement = document.createElement("iframe");
    document.body.append(replacement);
    frameRef.current = replacement;
    act(() => { replacement.dispatchEvent(new Event("load")); });
    act(() => {
      setEnv(true, true);
      replacement.contentWindow!.dispatchEvent(new Event("focus"));
    });
    expect(result.current).toBe(true);
    const remove = vi.spyOn(replacement.contentDocument!, "removeEventListener");
    unmount();
    expect(remove).toHaveBeenCalledWith("pointerdown", expect.any(Function), true);
    expect(remove).toHaveBeenCalledWith("keydown", expect.any(Function), true);
    frame.remove();
    replacement.remove();
  });

  it("remeasures a parent-window blur after focus settles inside an iframe", async () => {
    setEnv(true, true);
    const { result } = renderHook(() => useAppForeground());
    await act(async () => {
      setEnv(true, false);
      window.dispatchEvent(new Event("blur"));
      setEnv(true, true);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(result.current).toBe(true);
  });

  it("stays inactive when the settled window has really lost focus", async () => {
    setEnv(true, true);
    const { result } = renderHook(() => useAppForeground());
    await act(async () => {
      setEnv(true, false);
      window.dispatchEvent(new Event("blur"));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(result.current).toBe(false);
  });

  it("is true when the document is visible and focused", () => {
    setEnv(true, true);
    const { result } = renderHook(() => useAppForeground());
    expect(result.current).toBe(true);
  });

  it("is false when the window loses focus (another app / window on top)", () => {
    setEnv(true, false);
    const { result } = renderHook(() => useAppForeground());
    expect(result.current).toBe(false);
  });

  it("is false when the tab is hidden even if it still reports focus", () => {
    setEnv(false, true);
    const { result } = renderHook(() => useAppForeground());
    expect(result.current).toBe(false);
  });

  it("reacts to blur and focus events", () => {
    setEnv(true, true);
    const { result } = renderHook(() => useAppForeground());
    expect(result.current).toBe(true);

    act(() => {
      setEnv(true, false);
      window.dispatchEvent(new Event("blur"));
    });
    expect(result.current).toBe(false);

    act(() => {
      setEnv(true, true);
      window.dispatchEvent(new Event("focus"));
    });
    expect(result.current).toBe(true);
  });

  it("reacts to visibilitychange events", () => {
    setEnv(true, true);
    const { result } = renderHook(() => useAppForeground());
    expect(result.current).toBe(true);

    act(() => {
      setEnv(false, true);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current).toBe(false);
  });
});
