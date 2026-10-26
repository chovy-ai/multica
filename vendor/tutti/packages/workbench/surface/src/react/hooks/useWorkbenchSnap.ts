import { useCallback } from "react";
import {
  inferWorkbenchSnapTarget,
  WORKBENCH_EDGE_SNAP_THRESHOLD_PX
} from "../../core/geometry.ts";
import type { WorkbenchSnapTarget } from "../../core/types.ts";
import { useWorkbenchController } from "../WorkbenchProvider.tsx";
import { resolveWorkbenchActiveSnapTarget } from "./workbenchSnapTarget.ts";

export function useWorkbenchSnap<TData = unknown>() {
  const controller = useWorkbenchController<TData>();

  return useCallback(
    (
      pointerClientPoint: { x: number; y: number },
      options: { edgeSnapEnabled?: boolean } = {}
    ): WorkbenchSnapTarget => {
      const target = inferWorkbenchSnapTarget(
        pointerClientPoint,
        controller.getSnapshot().surfaceSize,
        options.edgeSnapEnabled ? WORKBENCH_EDGE_SNAP_THRESHOLD_PX : 0,
        controller.getSnapshot().layoutConstraints
      );
      const activeTarget = resolveWorkbenchActiveSnapTarget(target, options);
      controller.commands.setActiveSnapTarget(activeTarget);
      return activeTarget;
    },
    [controller]
  );
}
