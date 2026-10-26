import type { CreateWorkspaceFileManagerSessionInput } from "./workspaceFileManagerHost.interface.ts";
import type { WorkspaceFileManagerCommands } from "./internal/workspaceFileManagerCommands.ts";
import type {
  WorkspaceFileManagerFileActivationRequest,
  WorkspaceFileManagerHostFileActivationResult
} from "./workspaceFileManagerHostTypes.ts";
import type { WorkspaceFileManagerState } from "./workspaceFileManagerTypes.ts";

export interface WorkspaceFileManagerSession extends WorkspaceFileManagerCommands {
  activateFile(
    request: WorkspaceFileManagerFileActivationRequest
  ): Promise<WorkspaceFileManagerHostFileActivationResult>;
  dispose(): void;
  readonly store: WorkspaceFileManagerState;
}

export interface WorkspaceFileManagerService {
  createSession(
    input: CreateWorkspaceFileManagerSessionInput
  ): WorkspaceFileManagerSession;
}
