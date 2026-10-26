import { DefaultWorkspaceFileManagerService } from "./internal/workspaceFileManagerService.ts";
import type { WorkspaceFileManagerService } from "./workspaceFileManagerService.interface.ts";

export function createWorkspaceFileManagerService(): WorkspaceFileManagerService {
  return new DefaultWorkspaceFileManagerService();
}
