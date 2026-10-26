import { useRef, useSyncExternalStore } from "react";
import type { ExternalStoreSnapshotSource } from "./types.ts";

export function useExternalStoreSelector<TSnapshot, TResult>(
  source: ExternalStoreSnapshotSource<TSnapshot>,
  selector: (snapshot: TSnapshot) => TResult
): TResult {
  const selectedSnapshotRef = useRef<{
    selector: (snapshot: TSnapshot) => TResult;
    snapshot: TSnapshot;
    value: TResult;
  } | null>(null);

  const readSelection = (snapshot: TSnapshot) => {
    const selectedSnapshot = selectedSnapshotRef.current;
    if (
      selectedSnapshot?.snapshot === snapshot &&
      selectedSnapshot.selector === selector
    ) {
      return selectedSnapshot.value;
    }

    const value = selector(snapshot);
    selectedSnapshotRef.current = { selector, snapshot, value };
    return value;
  };

  return useSyncExternalStore(
    (listener) => source.subscribe(listener),
    () => readSelection(source.getSnapshot()),
    () => readSelection((source.getServerSnapshot ?? source.getSnapshot)())
  );
}
