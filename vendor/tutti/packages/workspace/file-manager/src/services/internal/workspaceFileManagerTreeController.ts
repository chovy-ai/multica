import {
  normalizeWorkspaceFilePath,
  sortWorkspaceEntries,
  workspaceFilePathHasHiddenSegment
} from "../workspaceFileManagerModel.ts";
import type { WorkspaceFileManagerHost } from "../workspaceFileManagerHost.interface.ts";
import type {
  WorkspaceFileEntry,
  WorkspaceFileManagerState
} from "../workspaceFileManagerTypes.ts";

export interface WorkspaceFileManagerTreeControllerInput {
  host: WorkspaceFileManagerHost;
  resolveErrorMessage: (error: unknown) => string;
  store: WorkspaceFileManagerState;
}

export class WorkspaceFileManagerTreeController {
  private readonly host: WorkspaceFileManagerHost;
  private readonly resolveErrorMessage: (error: unknown) => string;
  private readonly requestSeqByPath = new Map<string, number>();
  private readonly store: WorkspaceFileManagerState;

  constructor(input: WorkspaceFileManagerTreeControllerInput) {
    this.host = input.host;
    this.resolveErrorMessage = input.resolveErrorMessage;
    this.store = input.store;
  }

  clear(): void {
    this.requestSeqByPath.clear();
    this.store.directoryExpansionByPath = {};
    this.store.expandedDirectoryPaths = {};
  }

  async toggleDirectoryExpanded(entry: WorkspaceFileEntry): Promise<void> {
    if (entry.kind !== "directory" || !entry.hasChildren) {
      return;
    }

    const directoryPath = normalizeWorkspaceFilePath(
      entry.path,
      this.store.root
    );
    if (this.store.expandedDirectoryPaths[directoryPath]) {
      this.store.expandedDirectoryPaths = {
        ...this.store.expandedDirectoryPaths,
        [directoryPath]: false
      };
      return;
    }

    this.store.expandedDirectoryPaths = {
      ...this.store.expandedDirectoryPaths,
      [directoryPath]: true
    };

    const currentState = this.store.directoryExpansionByPath[directoryPath];
    if (currentState?.loaded || currentState?.isLoading) {
      return;
    }

    await this.loadDirectoryChildren(directoryPath);
  }

  private async loadDirectoryChildren(directoryPath: string): Promise<void> {
    const requestSeq = (this.requestSeqByPath.get(directoryPath) ?? 0) + 1;
    this.requestSeqByPath.set(directoryPath, requestSeq);

    const previousState = this.store.directoryExpansionByPath[directoryPath];
    this.store.directoryExpansionByPath = {
      ...this.store.directoryExpansionByPath,
      [directoryPath]: {
        entries: previousState?.entries ?? [],
        error: null,
        isLoading: true,
        loaded: previousState?.loaded ?? false
      }
    };

    try {
      const listing = await this.host.listDirectory({
        includeHidden: workspaceFilePathHasHiddenSegment(directoryPath),
        path: this.resolveRequestPath(directoryPath),
        workspaceID: this.store.workspaceID
      });
      if (this.requestSeqByPath.get(directoryPath) !== requestSeq) {
        return;
      }

      this.store.directoryExpansionByPath = {
        ...this.store.directoryExpansionByPath,
        [directoryPath]: {
          entries: sortWorkspaceEntries(listing.entries),
          error: null,
          isLoading: false,
          loaded: true
        }
      };
    } catch (error) {
      if (this.requestSeqByPath.get(directoryPath) !== requestSeq) {
        return;
      }

      this.store.directoryExpansionByPath = {
        ...this.store.directoryExpansionByPath,
        [directoryPath]: {
          entries: previousState?.entries ?? [],
          error: this.resolveErrorMessage(error),
          isLoading: false,
          loaded: false
        }
      };
    }
  }

  private resolveRequestPath(path: string): string {
    if (this.store.root === "/" && path === "/") {
      return "";
    }
    return path;
  }
}
