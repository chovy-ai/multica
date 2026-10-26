import { useLayoutEffect, useRef, useState } from "react";
import type { WorkbenchDockPreviewCache } from "../react/dockPreviewCache.ts";
import type { WorkbenchMinimizedDockNode } from "./minimizedDockSlots.ts";
import type { WorkbenchDockPreviewContent } from "./types.ts";
import { useWorkbenchMinimizedDockPreview } from "./useWorkbenchMinimizedDockPreview.ts";

export function WorkbenchHostDockMinimizedNodePreview({
  capturePreview,
  className,
  deferPreview = false,
  dockPreviewCache,
  node,
  providePreview,
  workspaceId
}: {
  capturePreview?: (
    node: WorkbenchMinimizedDockNode
  ) => Promise<string | null> | string | null;
  className?: string;
  deferPreview?: boolean;
  dockPreviewCache?: WorkbenchDockPreviewCache;
  node: WorkbenchMinimizedDockNode;
  providePreview?: (
    node: WorkbenchMinimizedDockNode
  ) => WorkbenchDockPreviewContent | null;
  workspaceId: string;
}) {
  const { componentPreview, previewImageUrl } =
    useWorkbenchMinimizedDockPreview({
      capturePreview,
      deferPreview,
      dockPreviewCache,
      node,
      providePreview,
      workspaceId
    });

  if (deferPreview) {
    return renderMinimizedDockPreviewPlaceholder(className);
  }

  if (previewImageUrl) {
    return renderMinimizedDockPreviewContent(
      { kind: "image", src: previewImageUrl },
      className
    );
  }

  if (componentPreview) {
    return renderMinimizedDockPreviewContent(componentPreview, className);
  }

  return renderMinimizedDockPreviewPlaceholder(className);
}

export function renderMinimizedDockPreviewPlaceholder(className?: string) {
  return (
    <span
      className={["desktop-dock__minimized-preview", className]
        .filter(Boolean)
        .join(" ")}
      aria-hidden="true"
    >
      <span className="desktop-dock__minimized-preview-line" />
      <span className="desktop-dock__minimized-preview-line desktop-dock__minimized-preview-line--short" />
      <span className="desktop-dock__minimized-preview-line desktop-dock__minimized-preview-line--accent" />
    </span>
  );
}

export function renderMinimizedDockPreviewContent(
  preview: WorkbenchDockPreviewContent,
  className?: string
) {
  if (preview.kind === "image") {
    return (
      <span
        className={[
          "desktop-dock__minimized-preview",
          "desktop-dock__minimized-preview--snapshot",
          className
        ]
          .filter(Boolean)
          .join(" ")}
        aria-hidden="true"
      >
        <img
          alt=""
          className="desktop-dock__minimized-preview-image"
          draggable={false}
          src={preview.src}
        />
      </span>
    );
  }

  return (
    <WorkbenchHostDockFrozenComponentPreview
      className={className}
      preview={preview}
    />
  );
}

function WorkbenchHostDockFrozenComponentPreview({
  className,
  preview
}: {
  className?: string;
  preview: Extract<WorkbenchDockPreviewContent, { kind: "component" }>;
}) {
  const sourceRef = useRef<HTMLSpanElement | null>(null);
  const [frozenMarkup, setFrozenMarkup] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (frozenMarkup !== null) {
      return;
    }
    setFrozenMarkup(sourceRef.current?.innerHTML ?? "");
  }, [frozenMarkup]);

  return (
    <span
      className={[
        "desktop-dock__minimized-preview",
        "desktop-dock__minimized-preview--component",
        className
      ]
        .filter(Boolean)
        .join(" ")}
      aria-hidden="true"
    >
      {frozenMarkup === null ? (
        <span
          ref={sourceRef}
          className="desktop-dock__minimized-preview-freeze-source"
        >
          {preview.element}
        </span>
      ) : (
        <span
          className="desktop-dock__minimized-preview-frozen-content"
          dangerouslySetInnerHTML={{ __html: frozenMarkup }}
        />
      )}
    </span>
  );
}

export function minimizedDockPreviewFreezeKey(
  node: WorkbenchMinimizedDockNode
): string {
  return `${node.id}:${node.minimizedAtUnixMs ?? "pending"}`;
}
