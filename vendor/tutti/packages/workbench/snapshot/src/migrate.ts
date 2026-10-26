import {
  workbenchSnapshotSchemaVersion,
  type WorkbenchSnapshotV1
} from "./types.ts";
import { normalizeWorkbenchSnapshot } from "./normalize.ts";
import { assertValidWorkbenchSnapshot } from "./validate.ts";

export function migrateWorkbenchSnapshot(value: unknown): WorkbenchSnapshotV1 {
  if (!isRecord(value)) {
    throw new Error("workbench snapshot must be an object");
  }

  if (value.schemaVersion === workbenchSnapshotSchemaVersion) {
    assertValidWorkbenchSnapshot(value);
    return normalizeWorkbenchSnapshot(value);
  }

  throw new Error(
    `unsupported workbench snapshot schema version: ${String(value.schemaVersion)}`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
