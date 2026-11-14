import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

const MAX_HISTORY_BYTES = 64 << 20;
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Enrich only messages the SDK selected, never other branches or hidden frames.
 * The SDK omits toolUseResult and timestamps from its public history DTO.
 */
export async function enrichHistory(sessionId: string, messages: SessionMessage[], configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")): Promise<SessionMessage[]> {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId) || !messages.length) return messages;
  const selected = new Map(messages.map((message) => [message.uuid, message]));
  const projects = join(configDir, "projects");
  let directories;
  try { directories = await readdir(projects, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return messages; throw error; }
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const path = join(projects, directory.name, `${sessionId}.jsonl`);
    let size;
    try { size = (await stat(path)).size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (size > MAX_HISTORY_BYTES) throw new Error("This conversation exceeds the history import size limit");
    const stream = createReadStream(path);
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let bytes = 0;
    try {
      for await (const line of lines) {
        bytes += Buffer.byteLength(line) + 1;
        if (bytes > MAX_HISTORY_BYTES) throw new Error("This conversation exceeds the history import size limit");
        let entry;
        try { entry = object(JSON.parse(line)); } catch { continue; }
        const message = typeof entry?.uuid === "string" ? selected.get(entry.uuid) : undefined;
        if (!message) continue;
        selected.set(message.uuid, {
          ...message,
          ...(typeof entry?.timestamp === "string" ? { timestamp: entry.timestamp } : {}),
          ...(object(entry?.toolUseResult) ? { tool_use_result: entry!.toolUseResult } : {}),
        });
      }
    } finally { lines.close(); stream.destroy(); }
    return messages.map((message) => selected.get(message.uuid)!);
  }
  return messages;
}
