import { readFile } from "node:fs/promises";
import path from "node:path";

import { getPackageRoot } from "./fileManifest.js";

export async function loadComponentsMetadata(): Promise<unknown> {
  const metadataPath = path.join(
    getPackageRoot(),
    "src/metadata/components.json"
  );
  const metadata = await readFile(metadataPath, "utf8");

  return JSON.parse(metadata);
}
