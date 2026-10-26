import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, sep } from "node:path";

export interface AvatarFile { name: string; mimeType: string; bytes: Uint8Array }
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

function imageType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

/** Resolve both sides so a symlink cannot expand a conversation's file access. */
export async function readAvatarFile(filePath: string, roots: string[], signal: AbortSignal): Promise<AvatarFile> {
  signal.throwIfAborted();
  if (!isAbsolute(filePath)) throw new Error("Avatar file_path must be absolute");
  const canonical = await realpath(filePath);
  let allowed = false;
  for (const root of roots) {
    const child = relative(await realpath(root), canonical);
    if (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)) { allowed = true; break; }
  }
  if (!allowed) throw new Error("Avatar file is outside the conversation working directory and selected files/folders");
  const mimeType = new Map([[".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"], [".webp", "image/webp"]]).get(extname(canonical).toLowerCase());
  if (!mimeType) throw new Error("Avatar must be a PNG, JPEG, GIF or WebP image");
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size === 0 || info.size > MAX_AVATAR_BYTES) throw new Error("Avatar must be a nonempty regular image file up to 5 MB");
    // Bound the read too: the file may grow after stat.
    const bytes = Buffer.alloc(MAX_AVATAR_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      signal.throwIfAborted();
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > MAX_AVATAR_BYTES) throw new Error("Avatar image exceeds 5 MB");
    const content = bytes.subarray(0, length);
    if (imageType(content) !== mimeType) throw new Error("Avatar image content does not match its file extension");
    signal.throwIfAborted();
    return { name: basename(canonical), mimeType, bytes: new Uint8Array(content) };
  } finally { await file.close(); }
}
