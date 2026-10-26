import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { UISystemDevFile } from "./protocol.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

const rejectedSegments = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
  "test-results"
]);
const allowedRootFiles = new Set([
  "AGENTS.md",
  "README.md",
  "ui-system.md",
  "package.json"
]);
const allowedSkillPathPrefix = "agent/tutti-ui-system/";

export function getPackageRoot(): string {
  return packageRoot;
}

export function normalizeSyncPath(input: string): string | null {
  if (hasTraversalSegment(input)) {
    return null;
  }

  let decoded: string;

  try {
    decoded = decodeURIComponent(input);
  } catch {
    return null;
  }

  if (hasTraversalSegment(decoded)) {
    return null;
  }

  const slashPath = decoded.replaceAll("\\", "/").replace(/^\/+/, "");
  const normalized = path.posix.normalize(slashPath);

  if (normalized === "." || normalized.startsWith("../")) {
    return null;
  }

  return normalized;
}

function hasTraversalSegment(input: string): boolean {
  return input.replaceAll("\\", "/").split("/").includes("..");
}

export function isAllowedSyncPath(input: string): boolean {
  const syncPath = normalizeSyncPath(input);

  if (syncPath === null) {
    return false;
  }

  const parts = syncPath.split("/");

  if (
    parts.some(
      (part) =>
        rejectedSegments.has(part) ||
        part.startsWith(".env") ||
        part.endsWith(".log")
    )
  ) {
    return false;
  }

  if (allowedRootFiles.has(syncPath)) {
    return true;
  }

  if (syncPath.startsWith(allowedSkillPathPrefix)) {
    return (
      syncPath.endsWith(".json") ||
      syncPath.endsWith(".md") ||
      syncPath.endsWith(".mjs")
    );
  }

  if (!syncPath.startsWith("src/")) {
    return false;
  }

  if (syncPath.startsWith("src/metadata/") && syncPath.endsWith(".json")) {
    return true;
  }

  return (
    syncPath.endsWith(".ts") ||
    syncPath.endsWith(".tsx") ||
    syncPath.endsWith(".css")
  );
}

export function resolveAllowedFile(input: string): string | null {
  const syncPath = normalizeSyncPath(input);

  if (syncPath === null || !isAllowedSyncPath(syncPath)) {
    return null;
  }

  const absolutePath = path.resolve(packageRoot, syncPath);
  const relativePath = path.relative(packageRoot, absolutePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }

  return absolutePath;
}

export async function hashFile(absolutePath: string): Promise<string> {
  const fileStat = await lstat(absolutePath);

  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new Error(`Refusing to hash non-regular file: ${absolutePath}`);
  }

  const bytes = await readFile(absolutePath);
  const hash = createHash("sha256").update(bytes).digest("hex");

  return `sha256:${hash}`;
}

export async function getSyncFile(
  input: string
): Promise<UISystemDevFile | null> {
  const syncPath = normalizeSyncPath(input);
  const absolutePath = resolveAllowedFile(input);

  if (syncPath === null || absolutePath === null) {
    return null;
  }

  try {
    const fileStat = await lstat(absolutePath);

    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      return null;
    }

    return {
      path: syncPath,
      hash: await hashFile(absolutePath),
      size: fileStat.size
    };
  } catch {
    return null;
  }
}

export async function getSyncFiles(): Promise<UISystemDevFile[]> {
  const files = await Promise.all([
    ...Array.from(allowedRootFiles, (syncPath) => getSyncFile(syncPath)),
    ...(
      await listSyncPaths(
        path.join(packageRoot, "agent", "tutti-ui-system"),
        "agent/tutti-ui-system"
      )
    ).map((syncPath) => getSyncFile(syncPath)),
    ...(await listSyncPaths(path.join(packageRoot, "src"), "src")).map(
      (syncPath) => getSyncFile(syncPath)
    )
  ]);

  return files
    .filter((file): file is UISystemDevFile => file !== null)
    .sort((left, right) => left.path.localeCompare(right.path));
}

async function listSyncPaths(
  absoluteDirectory: string,
  syncDirectory: string
): Promise<string[]> {
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const syncPath = `${syncDirectory}/${entry.name}`;

      if (entry.isDirectory() && isRejectedPath(syncPath)) {
        return [];
      }

      if (entry.isDirectory()) {
        return listSyncPaths(
          path.join(absoluteDirectory, entry.name),
          syncPath
        );
      }

      return isAllowedSyncPath(syncPath) ? [syncPath] : [];
    })
  );

  return paths.flat();
}

function isRejectedPath(syncPath: string): boolean {
  const parts = syncPath.split("/");

  return parts.some(
    (part) =>
      rejectedSegments.has(part) ||
      part.startsWith(".env") ||
      part.endsWith(".log")
  );
}
