import type { WorkbenchSnapTarget } from "../../core/types.ts";

export function resolveWorkbenchActiveSnapTarget(
  target: WorkbenchSnapTarget,
  options: { edgeSnapEnabled?: boolean } = {}
): WorkbenchSnapTarget {
  if (options.edgeSnapEnabled) {
    return target;
  }
  switch (target) {
    case "top":
    case "top-left":
    case "top-right":
      return "top";
    default:
      return null;
  }
}
