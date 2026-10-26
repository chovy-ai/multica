export interface WorkspaceDirectory {
  id: string;
  name: string;
  path: string;
}

export interface WorkspaceFileSelection {
  id: string;
  name: string;
  path: string;
}

export interface WorkspaceContextSelection {
  directories: WorkspaceDirectory[];
  files: WorkspaceFileSelection[];
}

export const MAX_WORKSPACE_CONTEXT_SELECTION_ENTRIES = 15;

export interface EnsureDirectoryInput {
  path: string;
}

export interface ReadWorkspaceFileInput {
  path: string;
}

export interface ReadWorkspaceFileResult {
  bytes: Uint8Array;
}

export interface WriteWorkspaceFileTextInput {
  path: string;
  content: string;
}

export interface WriteWorkspaceFileInput {
  path: string;
  bytes: Uint8Array;
}

export interface CopyWorkspacePathInput {
  path: string;
}
