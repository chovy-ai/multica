// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MentionPalette, type MentionPaletteState } from "@tutti-os/ui-rich-text/at-panel";

vi.mock("@multica/ui/components/ui/spinner", () => ({ Spinner: () => <svg data-testid="pagination-spinner" /> }));

let container: HTMLDivElement;
let root: Root;
const expand = vi.fn();
const state = (): Extract<MentionPaletteState<string>, { status: "ready" | "loading" }> => ({
  status: "ready", query: "review", mode: "results", filter: "issue", error: null,
  categories: [{ id: "issue", label: "Tasks" }],
  groups: [{ id: "issues", items: ["TES-130 review pr"], visibleCount: 1, totalCount: 2, hasMore: true,
    expandLabel: "Load more", expandLoadingLabel: "Loading more...", expandErrorLabel: "Retry" }],
});

async function render(value: MentionPaletteState<string>) {
  await act(async () => root.render(<MentionPalette
    state={value} highlightedKey={null} getItemKey={(item) => item} renderItem={(item) => item}
    labels={{ loading: "Loading...", empty: "No tasks", error: "Unable to load", tabHint: "References" }}
    hintLabels={{ cycleFilter: "Switch category", moveSelection: "Move selection" }} maxHeightPx={320}
    onHighlightChange={vi.fn()} onSelectItem={vi.fn()} onSelectCategory={vi.fn()} onSelectFilter={vi.fn()}
    onExpandGroup={expand} onCycleFilter={vi.fn()} onMoveSelection={vi.fn()}
  />));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  expand.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it.each(["group", "search"] as const)("shows a bottom spinner during %s pagination, preserving rows and preventing duplicate clicks", async (mode) => {
  const value = state();
  await render(value);
  expect(container.querySelector("[data-load-more-group] svg")).toBeNull();
  await render(mode === "group" ? { ...value, groups: [{ ...value.groups[0]!, expandStatus: "loading" }] } : { ...value, status: "loading" });
  const button = container.querySelector<HTMLButtonElement>("[data-load-more-group]")!;
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.querySelector('[data-testid="pagination-spinner"]')).not.toBeNull();
  expect(button.textContent).toBe("Loading more...");
  expect(container.querySelector('[role="option"]')?.textContent).toBe("TES-130 review pr");
  await act(async () => button.click()); expect(expand).not.toHaveBeenCalled();
  await render({ ...value, groups: [{ ...value.groups[0]!, items: [...value.groups[0]!.items, "TES-131 review another pr"], hasMore: false, visibleCount: 2 }] });
  expect(container.querySelectorAll('[role="option"]')).toHaveLength(2);
  expect(container.querySelector("[data-load-more-group]")).toBeNull();
});

it("removes the spinner after a failed page and retains the retry action", async () => {
  const value = state();
  await render({ ...value, groups: [{ ...value.groups[0]!, expandStatus: "loading" }] });
  await render({ ...value, groups: [{ ...value.groups[0]!, expandStatus: "error" }] });
  const button = container.querySelector<HTMLButtonElement>("[data-load-more-group]")!;
  expect(button.querySelector("svg")).toBeNull(); expect(button.disabled).toBe(false);
  expect(button.hasAttribute("aria-busy")).toBe(false); expect(button.textContent).toBe("Retry");
  await act(async () => button.click()); expect(expand).toHaveBeenCalledExactlyOnceWith("issues");
});
