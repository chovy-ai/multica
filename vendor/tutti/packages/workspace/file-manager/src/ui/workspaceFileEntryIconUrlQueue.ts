import type { WorkspaceFileEntry } from "../services/workspaceFileManagerTypes.ts";
import {
  resolveWorkspaceFileEntryIconCacheKey,
  shouldResolveWorkspaceFileEntryIcon
} from "./workspaceFileEntryIconPolicy.ts";

export type WorkspaceFileEntryIconUrlResolver = (
  entry: WorkspaceFileEntry
) => Promise<string | null | undefined>;

export interface WorkspaceFileEntryIconUrlQueueOptions {
  includeImageThumbnails?: boolean;
  maxConcurrent?: number;
  resolveEntryIconUrl?: WorkspaceFileEntryIconUrlResolver;
}

export interface WorkspaceFileEntryIconUrlQueue {
  activate(): void;
  dispose(): void;
  enterViewport(entry: WorkspaceFileEntry): void;
  leaveViewport(entry: WorkspaceFileEntry): void;
  retainEntries(entries: readonly WorkspaceFileEntry[]): void;
  snapshot(): ReadonlyMap<string, string | null>;
  subscribe(listener: () => void): () => void;
}

const defaultMaxConcurrentIconRequests = 3;
const imageThumbnailCacheKeyPrefix = "image-thumbnail:";

function shouldKeepResolvedIconAfterViewportLeave(cacheKey: string): boolean {
  return cacheKey.startsWith(imageThumbnailCacheKeyPrefix);
}

export function createWorkspaceFileEntryIconUrlQueue(
  options: WorkspaceFileEntryIconUrlQueueOptions
): WorkspaceFileEntryIconUrlQueue {
  const maxConcurrent = Math.max(
    1,
    Math.floor(options.maxConcurrent ?? defaultMaxConcurrentIconRequests)
  );
  const iconUrlByCacheKey = new Map<string, string | null>();
  const inFlightCacheKeys = new Set<string>();
  const listeners = new Set<() => void>();
  const queuedEntries = new Map<string, WorkspaceFileEntry>();
  const visibleReferenceCountByCacheKey = new Map<string, number>();
  let activeCount = 0;
  let disposed = false;
  let retainedCacheKeys: ReadonlySet<string> | null = null;
  const policyOptions = {
    includeImageThumbnails: options.includeImageThumbnails
  };

  function publish(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  function isRetained(cacheKey: string): boolean {
    return retainedCacheKeys === null || retainedCacheKeys.has(cacheKey);
  }

  function isVisible(cacheKey: string): boolean {
    return (visibleReferenceCountByCacheKey.get(cacheKey) ?? 0) > 0;
  }

  function shouldResolveCacheKey(cacheKey: string): boolean {
    return (
      isVisible(cacheKey) || shouldKeepResolvedIconAfterViewportLeave(cacheKey)
    );
  }

  function retainVisibleReference(cacheKey: string): void {
    visibleReferenceCountByCacheKey.set(
      cacheKey,
      (visibleReferenceCountByCacheKey.get(cacheKey) ?? 0) + 1
    );
  }

  function releaseVisibleReference(cacheKey: string): void {
    const nextCount = (visibleReferenceCountByCacheKey.get(cacheKey) ?? 0) - 1;
    if (nextCount > 0) {
      visibleReferenceCountByCacheKey.set(cacheKey, nextCount);
      return;
    }

    visibleReferenceCountByCacheKey.delete(cacheKey);
    if (shouldKeepResolvedIconAfterViewportLeave(cacheKey)) {
      return;
    }

    queuedEntries.delete(cacheKey);
    const hadCachedIcon = iconUrlByCacheKey.delete(cacheKey);
    if (hadCachedIcon) {
      publish();
    }
  }

  function drain(): void {
    if (disposed || !options.resolveEntryIconUrl) {
      return;
    }

    while (activeCount < maxConcurrent && queuedEntries.size > 0) {
      const next = queuedEntries.entries().next().value;
      if (!next) {
        return;
      }

      const [cacheKey, entry] = next;
      queuedEntries.delete(cacheKey);
      if (
        !shouldResolveCacheKey(cacheKey) ||
        iconUrlByCacheKey.has(cacheKey) ||
        inFlightCacheKeys.has(cacheKey)
      ) {
        continue;
      }

      activeCount += 1;
      inFlightCacheKeys.add(cacheKey);

      void options
        .resolveEntryIconUrl(entry)
        .then((iconUrl) => {
          const shouldStore =
            !disposed &&
            isRetained(cacheKey) &&
            shouldResolveCacheKey(cacheKey);
          if (shouldStore) {
            iconUrlByCacheKey.set(cacheKey, iconUrl?.trim() || null);
            publish();
          }
        })
        .catch(() => {
          const shouldStore =
            !disposed &&
            isRetained(cacheKey) &&
            shouldResolveCacheKey(cacheKey);
          if (shouldStore) {
            iconUrlByCacheKey.set(cacheKey, null);
            publish();
          }
        })
        .finally(() => {
          activeCount -= 1;
          inFlightCacheKeys.delete(cacheKey);
          drain();
        });
    }
  }

  return {
    activate(): void {
      disposed = false;
    },
    dispose(): void {
      disposed = true;
      queuedEntries.clear();
      visibleReferenceCountByCacheKey.clear();
      listeners.clear();
    },
    leaveViewport(entry): void {
      if (
        disposed ||
        !shouldResolveWorkspaceFileEntryIcon(entry, policyOptions)
      ) {
        return;
      }

      const cacheKey = resolveWorkspaceFileEntryIconCacheKey(entry);
      releaseVisibleReference(cacheKey);
    },
    enterViewport(entry): void {
      if (
        disposed ||
        !options.resolveEntryIconUrl ||
        !shouldResolveWorkspaceFileEntryIcon(entry, policyOptions)
      ) {
        return;
      }

      const cacheKey = resolveWorkspaceFileEntryIconCacheKey(entry);
      retainVisibleReference(cacheKey);
      if (
        iconUrlByCacheKey.has(cacheKey) ||
        inFlightCacheKeys.has(cacheKey) ||
        queuedEntries.has(cacheKey)
      ) {
        return;
      }

      queuedEntries.set(cacheKey, entry);
      drain();
    },
    retainEntries(entries): void {
      retainedCacheKeys = new Set(
        entries
          .filter((entry) =>
            shouldResolveWorkspaceFileEntryIcon(entry, policyOptions)
          )
          .map((entry) => resolveWorkspaceFileEntryIconCacheKey(entry))
      );
      let changed = false;
      for (const cacheKey of iconUrlByCacheKey.keys()) {
        if (!isRetained(cacheKey)) {
          iconUrlByCacheKey.delete(cacheKey);
          changed = true;
          continue;
        }
        if (iconUrlByCacheKey.get(cacheKey) === null) {
          iconUrlByCacheKey.delete(cacheKey);
          changed = true;
        }
      }
      for (const cacheKey of queuedEntries.keys()) {
        if (!isRetained(cacheKey)) {
          queuedEntries.delete(cacheKey);
        }
      }
      for (const cacheKey of visibleReferenceCountByCacheKey.keys()) {
        if (!isRetained(cacheKey)) {
          visibleReferenceCountByCacheKey.delete(cacheKey);
        }
      }
      if (changed) {
        publish();
      }
    },
    snapshot(): ReadonlyMap<string, string | null> {
      return new Map(iconUrlByCacheKey);
    },
    subscribe(listener): () => void {
      if (disposed) {
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}
