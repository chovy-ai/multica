import { useCallback, useState } from "react";
import {
  readWorkspaceFileManagerLayoutMode,
  writeWorkspaceFileManagerLayoutMode,
  type WorkspaceFileManagerLayoutMode
} from "./workspaceFileManagerLayoutMode.ts";

export function useWorkspaceFileManagerLayoutMode(): {
  layoutMode: WorkspaceFileManagerLayoutMode;
  setLayoutMode: (layoutMode: WorkspaceFileManagerLayoutMode) => void;
} {
  const [layoutMode, setLayoutModeState] = useState(
    readWorkspaceFileManagerLayoutMode
  );

  const setLayoutMode = useCallback(
    (nextLayoutMode: WorkspaceFileManagerLayoutMode) => {
      setLayoutModeState(nextLayoutMode);
      writeWorkspaceFileManagerLayoutMode(nextLayoutMode);
    },
    []
  );

  return { layoutMode, setLayoutMode };
}
