export const workbenchSnapshotLimits = {
  maxSerializedBytes: 512 * 1024,
  maxNodes: 128,
  maxNodeIDLength: 160,
  maxKindLength: 120,
  maxTitleLength: 240,
  minFrameWidth: 160,
  minFrameHeight: 120,
  maxFrameCoordinate: 1_000_000,
  maxFrameSize: 1_000_000
} as const;
