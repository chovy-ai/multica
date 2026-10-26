import { migrateWorkbenchSnapshot } from "./migrate.ts";
import { normalizeWorkbenchSnapshot } from "./normalize.ts";
import type { WorkbenchSnapshotV1 } from "./types.ts";
import { assertValidWorkbenchSnapshot } from "./validate.ts";

export function serializeWorkbenchSnapshot(
  snapshot: WorkbenchSnapshotV1
): string {
  const normalized = normalizeWorkbenchSnapshot(snapshot);
  assertValidWorkbenchSnapshot(normalized);
  return JSON.stringify(normalized);
}

export function parseWorkbenchSnapshot(
  serialized: string
): WorkbenchSnapshotV1 {
  const parsed = JSON.parse(serialized) as unknown;
  return migrateWorkbenchSnapshot(parsed);
}
