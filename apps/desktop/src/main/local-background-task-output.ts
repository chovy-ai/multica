import { open } from "node:fs/promises";
import { constants } from "node:fs";

const MAX_OUTPUT_BYTES = 32 * 1024;

/** Only read the output locator supplied by the CLI's task notification. */
export async function readBackgroundTaskOutput(path: string): Promise<{ output?: string; outputTruncated?: boolean }> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return {};
      const size = Math.min(stat.size, MAX_OUTPUT_BYTES);
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await file.read(buffer, 0, size, Math.max(0, stat.size - size));
      return { output: buffer.subarray(0, bytesRead).toString("utf8"), outputTruncated: stat.size > size };
    } finally { await file.close(); }
  } catch { return {}; }
}
