import { useExternalStoreSelector } from "@tutti-os/ui-react-hooks";
import type { WorkbenchState } from "../../core/types.ts";
import { useWorkbenchController } from "../WorkbenchProvider.tsx";

export function useWorkbenchSelector<TData, TResult>(
  selector: (state: WorkbenchState<TData>) => TResult
): TResult {
  const controller = useWorkbenchController<TData>();
  return useExternalStoreSelector(controller, selector);
}
