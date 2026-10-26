import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchNode } from "../core/types.ts";
import { createWorkbenchNodePreviewCaptureAdapter } from "./createWorkbenchNodePreviewCaptureAdapter.ts";

const previewImages = {
  dockPreviewImageUrl: "data:image/png;base64,ZG9jaw==",
  genieImageUrl: "data:image/png;base64,Z2VuaWU="
};

function createNode(
  input: { id?: string; isMinimized?: boolean } = {}
): WorkbenchNode {
  return {
    data: null,
    displayMode: "floating",
    frame: { height: 400, width: 600, x: 30, y: 40 },
    id: input.id ?? "node-1",
    isMinimized: input.isMinimized ?? false,
    kind: "test",
    minimizedAtUnixMs: null,
    restoreFrame: null,
    title: "Node"
  };
}

function installCaptureTarget(
  input: {
    focused?: boolean;
    rect?: Partial<DOMRect>;
  } = {}
): HTMLElement {
  document.body.innerHTML = `
    <section
      data-focused="${input.focused ?? true}"
      data-workbench-window-id="node-1"
    >
      <div data-workbench-window-capture="true"></div>
    </section>
  `;
  const target = document.querySelector<HTMLElement>(
    '[data-workbench-window-capture="true"]'
  );
  if (!target) {
    throw new Error("Expected capture target");
  }
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
    bottom: 440,
    height: 400,
    left: 30,
    right: 630,
    top: 40,
    width: 600,
    x: 30,
    y: 40,
    ...input.rect,
    toJSON: () => ({})
  } as DOMRect);
  return target;
}

describe("createWorkbenchNodePreviewCaptureAdapter", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible"
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 800
    });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("captures the focused visible node through the injected transport", async () => {
    installCaptureTarget();
    const captureRect = vi.fn().mockResolvedValue(previewImages);
    const capture = createWorkbenchNodePreviewCaptureAdapter({
      captureRect,
      maxHeight: 170,
      maxWidth: 260
    });

    await expect(capture(createNode())).resolves.toEqual(previewImages);
    expect(captureRect).toHaveBeenCalledWith({
      maxHeight: 170,
      maxWidth: 260,
      nodeId: "node-1",
      rect: { height: 400, width: 600, x: 30, y: 40 }
    });
  });

  it.each([
    ["node_minimized", { isMinimized: true }],
    ["document_not_visible", { visibilityState: "hidden" }],
    ["window_not_focused", { focused: false }],
    ["capture_rect_invalid", { rect: { left: 900, right: 1500 } }]
  ])("skips capture when %s", async (reason, setup) => {
    installCaptureTarget({
      focused: "focused" in setup ? setup.focused : undefined,
      rect: "rect" in setup ? setup.rect : undefined
    });
    if ("visibilityState" in setup) {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: setup.visibilityState
      });
    }
    const captureRect = vi.fn().mockResolvedValue(previewImages);
    const diagnostics = vi.fn();
    const capture = createWorkbenchNodePreviewCaptureAdapter({
      captureRect,
      diagnostics,
      maxHeight: 170,
      maxWidth: 260
    });

    await expect(
      capture(
        createNode({
          isMinimized: "isMinimized" in setup ? setup.isMinimized : undefined
        })
      )
    ).resolves.toBeNull();
    expect(captureRect).not.toHaveBeenCalled();
    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ reason }),
        event: "capture_skipped"
      })
    );
  });

  it("adds product diagnostic context without coupling the shared adapter", async () => {
    installCaptureTarget();
    const diagnostics = vi.fn();
    const capture = createWorkbenchNodePreviewCaptureAdapter({
      captureRect: vi.fn().mockResolvedValue(previewImages),
      diagnostics,
      maxHeight: 170,
      maxWidth: 260,
      resolveDiagnosticContext: (node) => ({
        typeId: "terminal",
        workspaceId: `workspace-for-${node.id}`
      })
    });

    await capture(createNode());

    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          typeId: "terminal",
          workspaceId: "workspace-for-node-1"
        }),
        event: "capture_requested"
      })
    );
  });

  it("contains transport rejection and emits a failed diagnostic", async () => {
    installCaptureTarget();
    const diagnostics = vi.fn();
    const capture = createWorkbenchNodePreviewCaptureAdapter({
      captureRect: vi.fn().mockRejectedValue(new Error("ipc failed")),
      diagnostics,
      maxHeight: 170,
      maxWidth: 260
    });

    await expect(capture(createNode())).resolves.toBeNull();
    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ error: "ipc failed" }),
        event: "capture_failed"
      })
    );
  });

  it("contains synchronous transport failures and emits a failed diagnostic", async () => {
    installCaptureTarget();
    const diagnostics = vi.fn();
    const capture = createWorkbenchNodePreviewCaptureAdapter({
      captureRect: vi.fn(() => {
        throw new Error("synchronous ipc failure");
      }),
      diagnostics,
      maxHeight: 170,
      maxWidth: 260
    });

    await expect(capture(createNode())).resolves.toBeNull();
    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ error: "synchronous ipc failure" }),
        event: "capture_failed"
      })
    );
  });

  it("stops waiting after the configured timeout", async () => {
    vi.useFakeTimers();
    installCaptureTarget();
    const diagnostics = vi.fn();
    const capture = createWorkbenchNodePreviewCaptureAdapter({
      captureRect: vi.fn(
        (): Promise<typeof previewImages | null> => new Promise(() => undefined)
      ),
      diagnostics,
      maxHeight: 170,
      maxWidth: 260,
      timeoutMs: 25
    });

    const result = capture(createNode());
    await vi.advanceTimersByTimeAsync(25);

    await expect(result).resolves.toBeNull();
    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ event: "capture_timed_out" })
    );
  });
});
