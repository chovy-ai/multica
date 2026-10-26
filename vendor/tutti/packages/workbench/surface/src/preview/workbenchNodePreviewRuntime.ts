import type { WorkbenchDockPreviewCacheKey } from "../react/dockPreviewCache.ts";

export interface WorkbenchNodePreviewRequest {
  capture?: () => Promise<string | null> | string | null;
  identity: string;
  nodeId: string;
  readPersisted?: () => Promise<string | null>;
  writePersisted?: (previewImageUrl: string) => Promise<unknown> | unknown;
}

export interface WorkbenchNodePreviewRuntime {
  ensure(request: WorkbenchNodePreviewRequest): Promise<string | null>;
  read(identity: string): string | null;
  readLatest(nodeId: string): string | null;
  write(input: {
    identity: string;
    nodeId: string;
    previewImageUrl: string | null | undefined;
  }): void;
}

const defaultMaxEntries = 96;

export function createWorkbenchNodePreviewRuntime(
  input: { maxEntries?: number } = {}
): WorkbenchNodePreviewRuntime {
  const maxEntries = input.maxEntries ?? defaultMaxEntries;
  const previewByIdentity = new Map<string, string>();
  const latestPreviewByNodeId = new Map<
    string,
    { identity: string; previewImageUrl: string }
  >();
  const pendingByIdentity = new Map<string, Promise<string | null>>();
  const activeIdentityByNodeId = new Map<string, string>();

  const writeIdentity = (identity: string, previewImageUrl: string): void => {
    previewByIdentity.delete(identity);
    previewByIdentity.set(identity, previewImageUrl);
    trimOldest(previewByIdentity, maxEntries);
  };

  const writeLatest = (
    nodeId: string,
    identity: string,
    previewImageUrl: string
  ): void => {
    latestPreviewByNodeId.delete(nodeId);
    latestPreviewByNodeId.set(nodeId, { identity, previewImageUrl });
    trimOldest(latestPreviewByNodeId, maxEntries);
  };

  return {
    async ensure(request) {
      activeIdentityByNodeId.set(request.nodeId, request.identity);
      const cached = previewByIdentity.get(request.identity);
      if (cached) {
        writeLatest(request.nodeId, request.identity, cached);
        return cached;
      }
      const pending = pendingByIdentity.get(request.identity);
      if (pending) {
        return pending;
      }

      const operation = (async (): Promise<string | null> => {
        const persistedPreview = await invokePreviewAdapter(
          request.readPersisted
        );
        if (persistedPreview) {
          writeIdentity(request.identity, persistedPreview);
          if (activeIdentityByNodeId.get(request.nodeId) === request.identity) {
            writeLatest(request.nodeId, request.identity, persistedPreview);
          }
          return persistedPreview;
        }

        const capturedPreview = await invokePreviewAdapter(request.capture);
        if (!capturedPreview) {
          return null;
        }
        writeIdentity(request.identity, capturedPreview);
        const isCurrentGeneration =
          activeIdentityByNodeId.get(request.nodeId) === request.identity;
        if (isCurrentGeneration) {
          writeLatest(request.nodeId, request.identity, capturedPreview);
        }
        if (isCurrentGeneration && request.writePersisted) {
          invokePreviewPersistence(request.writePersisted, capturedPreview);
        }
        return capturedPreview;
      })();
      pendingByIdentity.set(request.identity, operation);
      try {
        return await operation;
      } finally {
        if (pendingByIdentity.get(request.identity) === operation) {
          pendingByIdentity.delete(request.identity);
        }
      }
    },

    read(identity) {
      const previewImageUrl = previewByIdentity.get(identity) ?? null;
      if (previewImageUrl) {
        previewByIdentity.delete(identity);
        previewByIdentity.set(identity, previewImageUrl);
      }
      return previewImageUrl;
    },

    readLatest(nodeId) {
      const latest = latestPreviewByNodeId.get(nodeId) ?? null;
      if (latest) {
        latestPreviewByNodeId.delete(nodeId);
        latestPreviewByNodeId.set(nodeId, latest);
      }
      return latest?.previewImageUrl ?? null;
    },

    write({ identity, nodeId, previewImageUrl }) {
      if (!previewImageUrl) {
        return;
      }
      activeIdentityByNodeId.set(nodeId, identity);
      writeIdentity(identity, previewImageUrl);
      writeLatest(nodeId, identity, previewImageUrl);
    }
  };
}

async function invokePreviewAdapter(
  adapter: (() => Promise<string | null> | string | null) | undefined
): Promise<string | null> {
  if (!adapter) {
    return null;
  }
  try {
    return await adapter();
  } catch {
    return null;
  }
}

function invokePreviewPersistence(
  persist: (previewImageUrl: string) => Promise<unknown> | unknown,
  previewImageUrl: string
): void {
  try {
    void Promise.resolve(persist(previewImageUrl)).catch(() => undefined);
  } catch {
    // Product cache adapters are best-effort and must not break preview state.
  }
}

function trimOldest<TKey, TValue>(
  entries: Map<TKey, TValue>,
  maxEntries: number
): void {
  while (entries.size > maxEntries) {
    const oldestKey = entries.keys().next().value;
    if (oldestKey === undefined) {
      return;
    }
    entries.delete(oldestKey);
  }
}

export const workbenchNodePreviewRuntime = createWorkbenchNodePreviewRuntime();

export function workbenchNodePreviewIdentity(nodeId: string): string {
  return `node:${nodeId}`;
}

export function workbenchDockPreviewIdentity(
  key: WorkbenchDockPreviewCacheKey
): string {
  return JSON.stringify([
    key.workspaceId,
    key.typeId,
    key.instanceId,
    key.instanceKey ?? null,
    key.nodeId,
    key.revision ?? null
  ]);
}

export function workbenchMinimizedDockPreviewIdentity(
  key: WorkbenchDockPreviewCacheKey,
  minimizedAtUnixMs: number | null | undefined
): string {
  return `${workbenchDockPreviewIdentity(key)}:${minimizedAtUnixMs ?? "unknown"}`;
}
