import type { WorkbenchListener, WorkbenchUnsubscribe } from "./types.ts";

export function createWorkbenchSubscriptionSet() {
  const listeners = new Set<WorkbenchListener>();

  return {
    subscribe(listener: WorkbenchListener): WorkbenchUnsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify(): void {
      for (const listener of listeners) {
        listener();
      }
    }
  };
}
