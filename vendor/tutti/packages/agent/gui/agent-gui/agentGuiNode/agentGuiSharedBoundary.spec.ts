import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const selfFile = fileURLToPath(import.meta.url);

const legacyConversationScanRoots = ["agent-gui/agentGuiNode"];
const skippedDirectoryNames = new Set([".turbo", "dist", "node_modules"]);
const bannedImports = [
  "tshDesktop/AgentMessageMarkdown",
  "tshDesktop/agentConversation",
  "./AgentMessageMarkdown",
  "./agentConversation/",
  "../agentConversation/"
];

describe("AgentGUI shared renderer boundary", () => {
  it("does not import the old tshDesktop conversation renderer fork", () => {
    const offenders = scanSourceFiles(
      legacyConversationScanRoots.map((root) => join(packageRoot, root))
    )
      .filter((file) => file !== selfFile)
      .flatMap((file) => {
        const source = readFileSync(file, "utf8");
        return bannedImports
          .filter((bannedImport) => source.includes(bannedImport))
          .map((bannedImport) => `${file}: ${bannedImport}`);
      });

    expect(offenders).toEqual([]);
  });
});

function scanSourceFiles(roots: string[]): string[] {
  return roots.flatMap((root) => scanSourceFilesInDirectory(root));
}

function scanSourceFilesInDirectory(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      if (skippedDirectoryNames.has(entry)) {
        return [];
      }
      return scanSourceFilesInDirectory(path);
    }
    if (/\.(?:ts|tsx)$/.test(entry)) {
      return [path];
    }
    return [];
  });
}
