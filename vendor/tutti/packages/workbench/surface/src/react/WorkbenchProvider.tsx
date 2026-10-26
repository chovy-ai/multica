import { createContext, useContext, type PropsWithChildren } from "react";
import type { WorkbenchController } from "../store/types.ts";

const WorkbenchContext = createContext<WorkbenchController | null>(null);

export interface WorkbenchProviderProps<
  TData = unknown
> extends PropsWithChildren {
  controller: WorkbenchController<TData>;
}

export function WorkbenchProvider<TData>({
  children,
  controller
}: WorkbenchProviderProps<TData>) {
  return (
    <WorkbenchContext.Provider value={controller}>
      {children}
    </WorkbenchContext.Provider>
  );
}

export function useWorkbenchController<
  TData = unknown
>(): WorkbenchController<TData> {
  const controller = useContext(WorkbenchContext);
  if (!controller) {
    throw new Error("WorkbenchProvider is missing.");
  }
  return controller as WorkbenchController<TData>;
}
