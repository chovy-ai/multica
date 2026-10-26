import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { LocalPreviewFile, LocalPreviewLocation } from "@multica/tutti-agent-gui-host/local-protocol";
import { readAvatarFile } from "./local-avatar-file";

/** Only dialog-selected roots and this conversation's working directory are readable. */
export class LocalResourceReader {
  constructor(private directory: string) {}
  async avatar(path: string, cwd: string | undefined, signal: AbortSignal) {
    return readAvatarFile(path, [...(cwd ? [cwd] : []), ...await this.roots()], signal);
  }
  private async roots(): Promise<string[]> {
    try { const roots: unknown = JSON.parse(await readFile(join(this.directory, "preview-roots.json"), "utf8")); return Array.isArray(roots) ? roots.filter((item): item is string => typeof item === "string") : []; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async approve(path: string): Promise<LocalPreviewLocation> {
    const canonical = await realpath(path); const info = await stat(canonical);
    const root = canonical;
    const roots = await this.roots();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(join(this.directory, "preview-roots.json"), JSON.stringify([...new Set([...roots, root])]), { mode: 0o600 });
    return { root, path: canonical, name: basename(canonical), kind: info.isDirectory() ? "directory" : "file" };
  }
  private async path(root: string, path: string, cwd?: string) {
    const canonicalRoot = await realpath(root);
    const allowed = await this.roots();
    if (cwd) allowed.push(await realpath(cwd));
    if (!allowed.includes(canonicalRoot)) throw new Error("Choose this folder before previewing its contents");
    const canonical = await realpath(resolve(canonicalRoot, path));
    const child = relative(canonicalRoot, canonical);
    if (child === ".." || child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(child)) throw new Error("The file is outside the selected folder");
    return { root: canonicalRoot, path: canonical };
  }
  async list(root: string, path: string, cwd?: string): Promise<LocalPreviewLocation[]> {
    const location = await this.path(root, path, cwd);
    const entries = await readdir(location.path, { withFileTypes: true });
    return entries.filter((entry) => !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile())).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).slice(0, 1000).map((entry) => ({ root: location.root, path: join(location.path, entry.name), name: entry.name, kind: entry.isDirectory() ? "directory" : "file" }));
  }
  async read(root: string, path: string, cwd?: string): Promise<LocalPreviewFile> {
    const location = await this.path(root, path, cwd); const info = await stat(location.path);
    if (!info.isFile()) throw new Error("Select a file to preview");
    if (info.size > 10 * 1024 * 1024) throw new Error("Preview supports files up to 10 MB");
    const bytes = await readFile(location.path);
    const types: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".html": "text/html", ".htm": "text/html", ".pdf": "application/pdf" };
    const mimeType = types[extname(path).toLowerCase()] ?? "text/plain";
    const base = { name: basename(location.path), path: location.path, mimeType, size: bytes.length, truncated: false };
    if (mimeType.startsWith("image/") || mimeType === "application/pdf") return { ...base, data: bytes.toString("base64") };
    if (bytes.includes(0)) throw new Error("This binary format cannot be previewed");
    return { ...base, text: bytes.subarray(0, 1024 * 1024).toString("utf8"), truncated: bytes.length > 1024 * 1024 };
  }
}
