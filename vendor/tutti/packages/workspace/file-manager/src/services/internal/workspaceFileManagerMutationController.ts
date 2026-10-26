import {
  normalizeWorkspaceFilePath,
  workspaceFileDirectory
} from "../workspaceFileManagerModel.ts";
import type {
  WorkspaceFileManagerHost,
  WorkspaceFileManagerMutationErrorMessage
} from "../workspaceFileManagerHost.interface.ts";
import type {
  WorkspaceFileEntry,
  WorkspaceFileEntryKind,
  WorkspaceFileManagerState
} from "../workspaceFileManagerTypes.ts";
import { findWorkspaceFileEntry } from "./model/entryLookup.ts";

export interface WorkspaceFileManagerMutationControllerInput {
  host: WorkspaceFileManagerHost;
  onErrorMessage?: (
    message: WorkspaceFileManagerMutationErrorMessage
  ) => boolean | void;
  refresh: () => Promise<void>;
  resolveErrorMessage: (error: unknown) => string;
  store: WorkspaceFileManagerState;
}

export class WorkspaceFileManagerMutationController {
  private readonly host: WorkspaceFileManagerHost;
  private readonly onErrorMessage?: (
    message: WorkspaceFileManagerMutationErrorMessage
  ) => boolean | void;
  private readonly refresh: () => Promise<void>;
  private readonly resolveErrorMessage: (error: unknown) => string;
  private readonly store: WorkspaceFileManagerState;

  constructor(input: WorkspaceFileManagerMutationControllerInput) {
    this.host = input.host;
    this.onErrorMessage = input.onErrorMessage;
    this.refresh = input.refresh;
    this.resolveErrorMessage = input.resolveErrorMessage;
    this.store = input.store;
  }

  async createDirectory(path: string): Promise<void> {
    if (!this.host.createDirectory) {
      return;
    }
    await this.mutate(
      "create",
      () =>
        this.host.createDirectory?.({
          path: normalizeWorkspaceFilePath(path, this.store.root),
          workspaceID: this.store.workspaceID
        }) ?? Promise.resolve()
    );
  }

  async createFile(path: string): Promise<void> {
    if (!this.host.createFile) {
      return;
    }
    await this.mutate(
      "create",
      () =>
        this.host.createFile?.({
          path: normalizeWorkspaceFilePath(path, this.store.root),
          workspaceID: this.store.workspaceID
        }) ?? Promise.resolve()
    );
  }

  async deleteSelected(): Promise<void> {
    if (!this.host.deleteEntry || !this.store.selectedPath) {
      return;
    }

    const entry = findWorkspaceFileEntry(this.store, this.store.selectedPath);
    await this.mutate(
      "delete",
      () =>
        this.host.deleteEntry?.({
          kind: entryKindForDelete(entry?.kind),
          path: this.store.selectedPath ?? "",
          workspaceID: this.store.workspaceID
        }) ?? Promise.resolve()
    );
    this.store.selectedPath = null;
  }

  async moveEntry(
    entry: WorkspaceFileEntry,
    targetDirectoryPath: string
  ): Promise<void> {
    if (!this.host.moveEntry || entry.kind === "unknown") {
      return;
    }

    const entryKind = entry.kind;
    const normalizedTargetDirectoryPath = normalizeWorkspaceFilePath(
      targetDirectoryPath,
      this.store.root
    );
    if (entry.path === normalizedTargetDirectoryPath) {
      return;
    }
    if (
      entry.kind === "directory" &&
      normalizedTargetDirectoryPath.startsWith(`${entry.path}/`)
    ) {
      return;
    }
    if (
      workspaceFileDirectory(entry.path, this.store.root) ===
      normalizedTargetDirectoryPath
    ) {
      return;
    }

    let movedPath: string | null = null;
    await this.mutate("move", async () => {
      const movedEntry =
        (await this.host.moveEntry?.({
          kind: entryKind,
          path: entry.path,
          targetDirectoryPath: normalizedTargetDirectoryPath,
          workspaceID: this.store.workspaceID
        })) ?? null;
      movedPath = movedEntry?.path ?? null;
    });
    this.store.selectedPath = movedPath;
  }

  async renameEntry(entry: WorkspaceFileEntry, newName: string): Promise<void> {
    if (!this.host.renameEntry) {
      return;
    }

    let renamedPath: string | null = null;
    await this.mutate("rename", async () => {
      const renamedEntry =
        (await this.host.renameEntry?.({
          newName: newName.trim(),
          path: entry.path,
          workspaceID: this.store.workspaceID
        })) ?? null;
      renamedPath = renamedEntry?.path ?? null;
    });
    this.store.selectedPath = renamedPath;
  }

  private async mutate(
    actionKind: WorkspaceFileManagerMutationErrorMessage["actionKind"],
    operation: () => Promise<unknown>
  ): Promise<void> {
    this.store.isMutating = true;
    this.store.error = null;
    try {
      await operation();
      await this.refresh();
    } catch (error) {
      const message = this.resolveErrorMessage(error);
      const handled = this.onErrorMessage?.({
        actionKind,
        error,
        message
      });
      if (!handled) {
        this.store.error = message;
      }
    } finally {
      this.store.isMutating = false;
    }
  }
}

function entryKindForDelete(
  kind: WorkspaceFileEntryKind | undefined
): "file" | "directory" | null {
  if (kind === "file" || kind === "directory") {
    return kind;
  }
  return null;
}
