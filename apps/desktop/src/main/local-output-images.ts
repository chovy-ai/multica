import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import type { LocalConversation } from "@multica/tutti-agent-gui-host/local-protocol";

const imageTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
export interface OutputImage { data: string; mimeType: string; name: string }

/** Normalize actual provider image blocks; never fetch URLs found in tool output. */
export function inlineOutputImages(value: unknown): OutputImage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((block): OutputImage[] => {
    if (!block || typeof block !== "object") return [];
    let mimeType: unknown, data: unknown;
    if (block.type === "image") { mimeType = block.source?.media_type ?? block.mimeType; data = block.source?.data ?? block.data; }
    else if (block.type === "input_image" || block.type === "inputImage") {
      const match = typeof (block.image_url ?? block.imageUrl) === "string" ? (block.image_url ?? block.imageUrl).match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/) : null;
      mimeType = match?.[1]; data = match?.[2];
    }
    if (typeof mimeType !== "string" || !Object.values(imageTypes).includes(mimeType) || typeof data !== "string" || !data || data.length > 36_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return [];
    return [{ data, mimeType, name: `generated-image.${mimeType === "image/jpeg" ? "jpg" : mimeType.slice(6)}` }];
  }).slice(0, 20);
}

/** Recover generated files missing from the saved GUI transcript, including code-mode tool outputs. */
export async function discoverCodexOutputImages(entry: LocalConversation, codexHome = process.env.CODEX_HOME || join(homedir(), ".codex")): Promise<(OutputImage & { key: string; turnId: string })[]> {
  if (entry.provider !== "codex" || !entry.providerSessionId || !/^[0-9a-f-]{36}$/i.test(entry.providerSessionId)) return [];
  const folder = join(codexHome, "generated_images", entry.providerSessionId);
  let entries;
  try { entries = await readdir(folder, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const images: (OutputImage & { key: string; turnId: string; at: number })[] = [];
  for (const file of entries.filter((file) => file.isFile() && imageTypes[extname(file.name).toLowerCase()]).slice(0, 200)) {
    const key = `native-image:${file.name}`;
    if (entry.turns.some((turn) => turn.events?.some((event) => event.call_id === key))) continue;
    const handle = await open(join(folder, file.name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 25 * 1024 * 1024) continue;
      // Stored turn timestamps have millisecond precision; native files may have sub-millisecond mtimes.
      const createdAt = Math.floor(info.mtimeMs);
      const turn = entry.turns.find((turn) => !turn.remote && turn.status !== "running" && turn.completedAt && createdAt >= Date.parse(turn.createdAt) && createdAt <= Date.parse(turn.completedAt));
      if (!turn) continue;
      images.push({ key, turnId: turn.id, at: info.mtimeMs, name: file.name, mimeType: imageTypes[extname(file.name).toLowerCase()]!, data: (await handle.readFile()).toString("base64") });
      if (images.length === 20) break;
    } finally { await handle.close(); }
  }
  return images.sort((a, b) => a.at - b.at);
}
