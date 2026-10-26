import { useEffect, useState } from "react";
import type { WorkbenchDockPreviewCache } from "../react/dockPreviewCache.ts";
import type { WorkbenchDockPreviewContent } from "./types.ts";
import type { WorkbenchMinimizedDockNode } from "./minimizedDockSlots.ts";
import {
  workbenchMinimizedDockPreviewIdentity,
  workbenchNodePreviewRuntime
} from "../preview/workbenchNodePreviewRuntime.ts";

export interface WorkbenchMinimizedDockPreviewState {
  componentPreview: WorkbenchDockPreviewContent | null | undefined;
  previewImageUrl: string | null;
}

export function useWorkbenchMinimizedDockPreview({
  capturePreview,
  deferPreview,
  dockPreviewCache,
  node,
  providePreview,
  workspaceId
}: {
  capturePreview?: (
    node: WorkbenchMinimizedDockNode
  ) => Promise<string | null> | string | null;
  deferPreview: boolean;
  dockPreviewCache?: WorkbenchDockPreviewCache;
  node: WorkbenchMinimizedDockNode;
  providePreview?: (
    node: WorkbenchMinimizedDockNode
  ) => WorkbenchDockPreviewContent | null;
  workspaceId: string;
}): WorkbenchMinimizedDockPreviewState {
  const [componentPreview, setComponentPreview] = useState<
    WorkbenchDockPreviewContent | null | undefined
  >(undefined);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(() =>
    deferPreview ? null : workbenchNodePreviewRuntime.readLatest(node.id)
  );

  useEffect(() => {
    if (
      deferPreview ||
      !providePreview ||
      componentPreview !== undefined ||
      previewImageUrl
    ) {
      return undefined;
    }
    return scheduleDeferredPreview(() => {
      setComponentPreview(providePreview(node) ?? null);
    });
  }, [
    componentPreview,
    deferPreview,
    node.data.instanceId,
    node.data.instanceKey,
    node.data.typeId,
    node.id,
    node.minimizedAtUnixMs,
    previewImageUrl,
    providePreview
  ]);

  useEffect(() => {
    if (deferPreview) {
      return undefined;
    }

    let active = true;
    const cachedPreview = readWorkbenchMinimizedDockPreviewImage(node.id);
    setPreviewImageUrl(cachedPreview);
    void resolveWorkbenchMinimizedDockPreviewImage({
      capturePreview: capturePreview
        ? () => Promise.resolve(capturePreview(node))
        : undefined,
      dockPreviewCache,
      node,
      workspaceId
    }).then((nextPreview) => {
      if (active && nextPreview) {
        setPreviewImageUrl(nextPreview);
      }
    });

    return () => {
      active = false;
    };
  }, [
    capturePreview,
    deferPreview,
    dockPreviewCache,
    node.data.instanceId,
    node.data.instanceKey,
    node.data.typeId,
    node.id,
    node.minimizedAtUnixMs,
    workspaceId
  ]);

  return { componentPreview, previewImageUrl };
}

export function readWorkbenchMinimizedDockPreviewImage(
  nodeId: string
): string | null {
  return workbenchNodePreviewRuntime.readLatest(nodeId);
}

export function resolveWorkbenchMinimizedDockPreviewRevision(
  node: WorkbenchMinimizedDockNode
): string {
  return String(node.minimizedAtUnixMs);
}

export function resolveWorkbenchMinimizedDockPreviewImage({
  capturePreview,
  dockPreviewCache,
  node,
  workspaceId
}: {
  capturePreview?: () => Promise<string | null> | string | null;
  dockPreviewCache?: WorkbenchDockPreviewCache;
  node: WorkbenchMinimizedDockNode;
  workspaceId: string;
}): Promise<string | null> {
  const cacheKey = {
    instanceId: node.data.instanceId,
    instanceKey: node.data.instanceKey ?? null,
    nodeId: node.id,
    revision: resolveWorkbenchMinimizedDockPreviewRevision(node),
    typeId: node.data.typeId,
    workspaceId
  };
  const genieCacheKey = {
    ...cacheKey,
    revision: undefined
  };
  return workbenchNodePreviewRuntime.ensure({
    capture: capturePreview,
    identity: workbenchMinimizedDockPreviewIdentity(
      cacheKey,
      node.minimizedAtUnixMs
    ),
    nodeId: node.id,
    readPersisted: dockPreviewCache
      ? async () =>
          (await dockPreviewCache.read(cacheKey)) ??
          dockPreviewCache.read(genieCacheKey)
      : undefined,
    writePersisted: dockPreviewCache
      ? (previewImageUrl) =>
          dockPreviewCache.write({ key: cacheKey, previewImageUrl })
      : undefined
  });
}

function scheduleDeferredPreview(run: () => void): () => void {
  let cancelled = false;
  let frameId: number | null = null;
  let idleId: number | null = null;
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
  const invoke = () => {
    if (!cancelled) {
      run();
    }
  };
  const scheduler = globalThis as typeof globalThis & {
    cancelIdleCallback?: (id: number) => void;
    cancelAnimationFrame?: (id: number) => void;
    requestIdleCallback?: (
      callback: () => void,
      options?: { timeout?: number }
    ) => number;
    requestAnimationFrame?: (callback: () => void) => number;
  };

  if (typeof scheduler.requestIdleCallback === "function") {
    idleId = scheduler.requestIdleCallback(invoke, { timeout: 250 });
  } else if (typeof scheduler.requestAnimationFrame === "function") {
    frameId = scheduler.requestAnimationFrame(() => {
      frameId = null;
      timeoutId = globalThis.setTimeout(invoke, 0);
    });
  } else {
    timeoutId = globalThis.setTimeout(invoke, 0);
  }

  return () => {
    cancelled = true;
    if (idleId !== null && typeof scheduler.cancelIdleCallback === "function") {
      scheduler.cancelIdleCallback(idleId);
    }
    if (
      frameId !== null &&
      typeof scheduler.cancelAnimationFrame === "function"
    ) {
      scheduler.cancelAnimationFrame(frameId);
    }
    if (timeoutId !== null) {
      globalThis.clearTimeout(timeoutId);
    }
  };
}
