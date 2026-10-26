import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { renderMinimizedDockPreviewContent as renderMinimizedDockPreviewContentCompatibility } from "./WorkbenchHostDock.tsx";
import type { WorkbenchMinimizedDockNode } from "./minimizedDockSlots.ts";
import {
  minimizedDockPreviewFreezeKey,
  renderMinimizedDockPreviewContent,
  renderMinimizedDockPreviewPlaceholder
} from "./WorkbenchHostDockMinimizedPreview.tsx";

const mountedRoots: Array<{ container: HTMLDivElement; root: Root }> = [];
const previousActEnvironment = (
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT;

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

afterEach(async () => {
  while (mountedRoots.length > 0) {
    const mounted = mountedRoots.pop();
    if (!mounted) {
      continue;
    }
    await act(async () => {
      mounted.root.unmount();
    });
    mounted.container.remove();
  }
});

describe("WorkbenchHostDockMinimizedPreview", () => {
  it("preserves the WorkbenchHostDock file-level renderer export", () => {
    expect(renderMinimizedDockPreviewContentCompatibility).toBe(
      renderMinimizedDockPreviewContent
    );
  });

  it("renders image previews with the shared snapshot DOM contract", async () => {
    const container = await render(
      renderMinimizedDockPreviewContent(
        { kind: "image", src: "data:image/png;base64,preview" },
        "custom-preview"
      )
    );

    const preview = container.firstElementChild;
    expect(preview?.classList.contains("desktop-dock__minimized-preview")).toBe(
      true
    );
    expect(
      preview?.classList.contains("desktop-dock__minimized-preview--snapshot")
    ).toBe(true);
    expect(preview?.classList.contains("custom-preview")).toBe(true);
    expect(preview?.getAttribute("aria-hidden")).toBe("true");

    const image = preview?.querySelector("img");
    expect(image?.className).toBe("desktop-dock__minimized-preview-image");
    expect(image?.getAttribute("alt")).toBe("");
    expect(image?.draggable).toBe(false);
    expect(image?.getAttribute("src")).toBe("data:image/png;base64,preview");
  });

  it("renders the shared placeholder structure", async () => {
    const container = await render(
      renderMinimizedDockPreviewPlaceholder("custom-placeholder")
    );

    const preview = container.firstElementChild;
    expect(preview?.classList.contains("desktop-dock__minimized-preview")).toBe(
      true
    );
    expect(preview?.classList.contains("custom-placeholder")).toBe(true);
    expect(preview?.getAttribute("aria-hidden")).toBe("true");
    expect(
      Array.from(preview?.children ?? []).map((element) => element.className)
    ).toEqual([
      "desktop-dock__minimized-preview-line",
      "desktop-dock__minimized-preview-line desktop-dock__minimized-preview-line--short",
      "desktop-dock__minimized-preview-line desktop-dock__minimized-preview-line--accent"
    ]);
  });

  it("freezes component previews after mounting their source once", async () => {
    const refPhases: string[] = [];
    const container = await render(
      renderMinimizedDockPreviewContent({
        element: (
          <strong
            data-preview="component"
            ref={(element) => {
              refPhases.push(element ? "mounted" : "unmounted");
            }}
          >
            Preview
          </strong>
        ),
        kind: "component"
      })
    );

    expect(refPhases).toEqual(["mounted", "unmounted"]);
    expect(
      container.querySelector(".desktop-dock__minimized-preview-freeze-source")
    ).toBeNull();
    const frozen = container.querySelector(
      ".desktop-dock__minimized-preview-frozen-content"
    );
    expect(frozen?.innerHTML).toBe(
      '<strong data-preview="component">Preview</strong>'
    );
  });

  it("changes the freeze key when the minimized revision changes", () => {
    const node = {
      id: "node-1",
      minimizedAtUnixMs: 10
    } as WorkbenchMinimizedDockNode;

    expect(minimizedDockPreviewFreezeKey(node)).toBe("node-1:10");
    expect(
      minimizedDockPreviewFreezeKey({
        ...node,
        minimizedAtUnixMs: 11
      })
    ).toBe("node-1:11");
    expect(
      minimizedDockPreviewFreezeKey({
        ...node,
        minimizedAtUnixMs: undefined
      })
    ).toBe("node-1:pending");
  });
});

async function render(element: ReactElement): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push({ container, root });
  await act(async () => {
    root.render(element);
  });
  return container;
}
