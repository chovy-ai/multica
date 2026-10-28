import { execFile } from "node:child_process";
import type { TerminalCliVersion, TerminalCliVersionState } from "../shared/terminal-cli";

export function parseTerminalCliVersion(stdout: string): TerminalCliVersion | null {
  try {
    const value: unknown = JSON.parse(stdout);
    if (!value || typeof value !== "object" || !("version" in value)
      || typeof value.version !== "string" || !/^[\w.+-]{1,160}$/.test(value.version)) return null;
    const commit = "commit" in value && typeof value.commit === "string" && /^[a-f\d]{7,40}$/i.test(value.commit)
      ? value.commit.toLowerCase() : null;
    return { version: value.version.replace(/^v(?=\d)/, ""), commit };
  } catch { return null; }
}

/** Only the CLI's local version subcommand is run; never starts a daemon or logs in. */
export function readTerminalCliVersion(path: string, timeout = 5_000): Promise<TerminalCliVersion | null> {
  return new Promise((resolve) => {
    execFile(path, ["version", "--output", "json"], { timeout, maxBuffer: 16 * 1024, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : parseTerminalCliVersion(stdout));
    });
  });
}

export function terminalCliVersionState(current: TerminalCliVersion | null, bundled: TerminalCliVersion | null, detected: boolean): TerminalCliVersionState {
  if (!bundled) return "unknown";
  if (!detected) return "not_installed";
  if (!current) return "unknown";
  if (current.version === bundled.version) {
    if (current.commit && bundled.commit && !current.commit.startsWith(bundled.commit) && !bundled.commit.startsWith(current.commit)) return "different";
    // Untagged builds without revision metadata cannot establish a version match.
    if (current.version === "dev" && (!current.commit || !bundled.commit)) return "unknown";
    return "current";
  }
  const release = /^\d+\.\d+\.\d+$/;
  const describe = /^(\d+\.\d+\.\d+)-\d+-g[\da-f]+(?:-dirty)?$/i;
  const base = (version: string) => release.test(version) ? version : describe.exec(version)?.[1];
  const currentBase = base(current.version), bundledBase = base(bundled.version);
  if (currentBase && bundledBase) {
    const a = currentBase.split(".").map(Number), b = bundledBase.split(".").map(Number);
    for (let index = 0; index < 3; index++) {
      if (a[index]! < b[index]!) return "update_available";
      if (a[index]! > b[index]!) return "newer";
    }
    if (release.test(current.version) && describe.test(bundled.version)) return "update_available";
    if (describe.test(current.version) && release.test(bundled.version)) return "newer";
  }
  // Forks, prereleases and git-describe revisions have no reliable total ordering.
  return "different";
}
