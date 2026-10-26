// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMentionScrollPagination } from "./mention-scroll-pagination";

type State = Parameters<typeof useMentionScrollPagination>[1];
let container: HTMLDivElement;
let root: Root;
let markerTop: number;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
const initial = (): State => ({ status: "ready", filter: "issue", query: "", groups: [{ id: "issues", visibleCount: 10, hasMore: true }] });
function Harness({ state, expand }: { state: State; expand: (id: string) => void }) {
  const scroll = useRef<HTMLDivElement>(null);
  useMentionScrollPagination(scroll, state, expand);
  return <div ref={scroll} data-scroll>{state.groups.filter((group) => group.hasMore).map((group) => <button key={group.id} data-load-more-group={group.id}>Load more</button>)}</div>;
}
async function flushFrames() {
  await act(async () => {
    const batch = [...frames.values()]; frames.clear();
    for (const callback of batch) callback(0);
  });
}
async function scroll() {
  container.querySelector("[data-scroll]")!.dispatchEvent(new Event("scroll"));
  await flushFrames();
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frames = new Map(); nextFrame = 0; markerTop = 600;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-scroll") ? new DOMRect(0, 100, 400, 300) : new DOMRect(0, markerTop, 400, 30);
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("mention scroll pagination", () => {
  it("loads near the bottom once per page and waits while an expansion is in flight", async () => {
    const expand = vi.fn(); let state = initial();
    await act(async () => root.render(<Harness state={state} expand={expand} />));
    await flushFrames(); expect(expand).not.toHaveBeenCalled();
    markerTop = 420; await scroll(); await scroll(); expect(expand).toHaveBeenCalledExactlyOnceWith("issues");
    state = { ...state, status: "loading" };
    await act(async () => root.render(<Harness state={state} expand={expand} />));
    await scroll(); expect(expand).toHaveBeenCalledOnce();
    state = { ...initial(), groups: [{ id: "issues", visibleCount: 20, hasMore: true }] };
    markerTop = 700;
    await act(async () => root.render(<Harness state={state} expand={expand} />));
    await flushFrames(); expect(expand).toHaveBeenCalledOnce();
    markerTop = 390; await scroll(); expect(expand).toHaveBeenCalledTimes(2);
    state = { ...state, groups: [{ id: "issues", visibleCount: 24, hasMore: false }] };
    await act(async () => root.render(<Harness state={state} expand={expand} />));
    await scroll(); expect(expand).toHaveBeenCalledTimes(2);
  });
  it("resets pagination for a new search and cancels pending work when the palette closes", async () => {
    const expand = vi.fn(); markerTop = 350;
    await act(async () => root.render(<Harness state={initial()} expand={expand} />));
    await flushFrames(); expect(expand).toHaveBeenCalledOnce();
    await act(async () => root.render(<Harness state={{ ...initial(), query: "review" }} expand={expand} />));
    await flushFrames(); expect(expand).toHaveBeenCalledTimes(2);
    container.querySelector("[data-scroll]")!.dispatchEvent(new Event("scroll"));
    await act(async () => root.render(null));
    await flushFrames(); expect(expand).toHaveBeenCalledTimes(2); expect(frames.size).toBe(0);
  });
  it("does not automatically retry failed pages or load markers above the viewport", async () => {
    const expand = vi.fn(); markerTop = 350;
    const state = { ...initial(), groups: [{ id: "issues", visibleCount: 10, hasMore: true, expandStatus: "error" }] };
    await act(async () => root.render(<Harness state={state} expand={expand} />));
    await scroll(); expect(expand).not.toHaveBeenCalled();
    markerTop = 20;
    await act(async () => root.render(<Harness state={initial()} expand={expand} />));
    await scroll(); expect(expand).not.toHaveBeenCalled();
  });
});
