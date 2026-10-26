export interface ExternalStoreSnapshotSource<TSnapshot> {
  getServerSnapshot?(): TSnapshot;
  getSnapshot(): TSnapshot;
  subscribe(listener: () => void): () => void;
}
