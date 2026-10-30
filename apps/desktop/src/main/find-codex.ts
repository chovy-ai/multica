import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

/** The Codex CLI on PATH, or in the ChatGPT and Codex apps on macOS. */
export async function findCodex(): Promise<string | null> {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const candidates = (process.env.PATH ?? "").split(delimiter).flatMap((folder) => extensions.map((ext) => join(folder, `codex${ext.toLowerCase()}`)));
  if (process.platform === "darwin") candidates.push(
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  );
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next installed location. */ }
  }
  return null;
}
