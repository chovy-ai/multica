import { resolveWorkspaceFileExtension } from "@tutti-os/workspace-file-preview";
import type {
  WorkspaceFileEntry,
  WorkspaceFileOpenWithApplication
} from "../../workspaceFileManagerTypes.ts";

const openWithWarmupLimit = 8;

export function resolveWorkspaceFileOpenWithCacheKey(
  entry: Pick<WorkspaceFileEntry, "kind" | "name" | "path">
): string {
  const extension = resolveWorkspaceFileExtension(
    entry.path || entry.name || ""
  );
  return `${entry.kind}:${extension || "(no-ext)"}`;
}

export class WorkspaceFileOpenWithApplicationsCache {
  private readonly applicationsByKey = new Map<
    string,
    WorkspaceFileOpenWithApplication[]
  >();
  private readonly inflightByKey = new Map<
    string,
    Promise<WorkspaceFileOpenWithApplication[]>
  >();
  private readonly warmupScheduledKeys = new Set<string>();

  get(key: string): WorkspaceFileOpenWithApplication[] | null {
    return this.applicationsByKey.get(key) ?? null;
  }

  async resolve(
    key: string,
    load: () => Promise<WorkspaceFileOpenWithApplication[]>
  ): Promise<WorkspaceFileOpenWithApplication[]> {
    const cached = this.applicationsByKey.get(key);
    if (cached) {
      return cached;
    }

    const inflight = this.inflightByKey.get(key);
    if (inflight) {
      return inflight;
    }

    const promise = load()
      .then((applications) => {
        this.applicationsByKey.set(key, applications);
        this.inflightByKey.delete(key);
        return applications;
      })
      .catch((error) => {
        this.inflightByKey.delete(key);
        throw error;
      });
    this.inflightByKey.set(key, promise);
    return promise;
  }

  scheduleWarmup(
    entries: readonly WorkspaceFileEntry[],
    load: (
      entry: WorkspaceFileEntry
    ) => Promise<WorkspaceFileOpenWithApplication[]>
  ): void {
    let scheduled = 0;
    const seenKeys = new Set<string>();

    for (const entry of entries) {
      if (entry.kind !== "file" || scheduled >= openWithWarmupLimit) {
        continue;
      }

      const key = resolveWorkspaceFileOpenWithCacheKey(entry);
      if (
        seenKeys.has(key) ||
        this.applicationsByKey.has(key) ||
        this.inflightByKey.has(key) ||
        this.warmupScheduledKeys.has(key)
      ) {
        continue;
      }

      seenKeys.add(key);
      this.warmupScheduledKeys.add(key);
      scheduled += 1;
      void load(entry).finally(() => {
        this.warmupScheduledKeys.delete(key);
      });
    }
  }
}
