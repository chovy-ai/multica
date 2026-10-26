export function createDerivedSnapshotGetter<TSourceSnapshot, TSnapshot>(input: {
  deriveSnapshot: (sourceSnapshot: TSourceSnapshot) => TSnapshot;
  getSourceSnapshot: () => TSourceSnapshot;
}): () => TSnapshot {
  let cachedSourceSnapshot: TSourceSnapshot | null = null;
  let cachedSnapshot: TSnapshot | null = null;
  let hasCachedSnapshot = false;

  return () => {
    const sourceSnapshot = input.getSourceSnapshot();
    if (hasCachedSnapshot && cachedSourceSnapshot === sourceSnapshot) {
      return cachedSnapshot as TSnapshot;
    }

    const snapshot = input.deriveSnapshot(sourceSnapshot);
    cachedSourceSnapshot = sourceSnapshot;
    cachedSnapshot = snapshot;
    hasCachedSnapshot = true;
    return snapshot;
  };
}
