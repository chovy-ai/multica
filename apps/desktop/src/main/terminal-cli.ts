import { constants } from "node:fs";
import { access, appendFile, lstat, mkdir, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TerminalCliErrorCode, TerminalCliResult, TerminalCliSource, TerminalCliStatus } from "../shared/terminal-cli";
import { readTerminalCliVersion, terminalCliVersionState } from "./terminal-cli-version";

const START = "# >>> Multica Desktop CLI >>>";
const END = "# <<< Multica Desktop CLI <<<";
type InstallRecord = { target: string; shellFiles: string[] };
type Options = { home: string; source: TerminalCliSource; commandTarget?: string; platform: string; env: NodeJS.ProcessEnv; systemBinDirs?: string[] };

class InstallError extends Error {
  constructor(readonly code: TerminalCliErrorCode) { super(code); }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function executable(path: string): Promise<boolean> {
  try { await access(path, constants.X_OK); return (await stat(path)).isFile(); }
  catch { return false; }
}
async function linkTarget(path: string): Promise<string | null> {
  try { return await readlink(path); }
  catch (error) { if (["ENOENT", "EINVAL"].includes((error as NodeJS.ErrnoException).code ?? "")) return null; throw error; }
}
async function textFile(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}

/** User-scoped terminal installation. Never changes the daemon's profile or credentials. */
export class TerminalCliInstaller {
  private pending: Promise<void> = Promise.resolve();
  private readonly command: string;
  private readonly recordPath: string;
  private readonly block: string;

  constructor(private readonly options: Options) {
    const binDir = join(options.home, ".local", "bin");
    this.command = join(binDir, "multica");
    this.recordPath = join(options.home, ".local", "share", "multica", "terminal-cli.json");
    const quoted = `'${binDir.replaceAll("'", "'\\''")}'`;
    this.block = `\n${START}\nexport PATH=${quoted}:"$PATH"\n${END}\n`;
  }

  private async shellFiles(): Promise<string[]> {
    const { home, env, platform } = this.options;
    if (platform !== "darwin" && platform !== "linux") return [];
    if (basename(env.SHELL ?? "") === "zsh") {
      const directory = env.ZDOTDIR || home;
      return isAbsolute(directory) ? [join(directory, ".zshrc")] : [];
    }
    if (basename(env.SHELL ?? "") === "bash") {
      const candidates = [".bash_profile", ".bash_login", ".profile"].map((name) => join(home, name));
      let login = candidates[0]!;
      for (const path of candidates) { if (await exists(path)) { login = path; break; } }
      return [join(home, ".bashrc"), login];
    }
    return [];
  }

  private async record(): Promise<InstallRecord | null> {
    const raw = await textFile(this.recordPath);
    if (!raw) return null;
    // A corrupt ownership record must never authorize replacing another command.
    try {
      const value = JSON.parse(raw) as InstallRecord;
      if (typeof value.target === "string" && isAbsolute(value.target) && Array.isArray(value.shellFiles)
        && value.shellFiles.every((path) => typeof path === "string" && isAbsolute(path))) return value;
    } catch { /* Treat invalid ownership as an unmanaged installation. */ }
    return null;
  }

  async status(): Promise<TerminalCliStatus> {
    const shellFiles = await this.shellFiles();
    const record = await this.record();
    const target = await linkTarget(this.command);
    const managed = record !== null;
    const ownedLink = managed && target === record.target;
    const commandTarget = this.options.commandTarget ?? this.options.source.cliPath;
    const pointsToSource = target === commandTarget && await realpath(commandTarget).catch(() => null) === await realpath(this.options.source.cliPath).catch(() => undefined);
    let conflictPath: string | null = null;
    if (await exists(this.command) && !ownedLink) conflictPath = this.command;
    const configured = shellFiles.length > 0 && (await Promise.all(shellFiles.map(textFile))).every((value) => value.includes(this.block));
    let pathCli: string | null = null;
    const dirs = new Set([...(this.options.env.PATH ?? "").split(delimiter).filter(Boolean), ...(this.options.systemBinDirs ?? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"])]);
    for (const dir of dirs) {
      const candidate = join(dir, "multica");
      if (await executable(candidate)) { pathCli = candidate; break; }
    }
    const commandAvailable = await executable(this.command);
    // The added shell block prepends this command in new terminals. Without it,
    // inspect PATH order instead of claiming an unused owned link is current.
    const detectedPath = commandAvailable && ownedLink && configured ? this.command : pathCli;
    const [bundledVersion, currentVersion] = await Promise.all([
      await executable(this.options.source.cliPath) ? readTerminalCliVersion(this.options.source.cliPath) : null,
      detectedPath ? readTerminalCliVersion(detectedPath) : null,
    ]);
    const bundleAvailable = bundledVersion !== null;
    return {
      supported: shellFiles.length > 0, bundleAvailable, managed,
      source: this.options.source,
      bindingState: ownedLink ? pointsToSource ? "current" : "other" : detectedPath ? "unmanaged" : "missing",
      installed: managed && pointsToSource && bundleAvailable && configured,
      commandPath: this.command, conflictPath, shellFiles, detectedPath, currentVersion, bundledVersion,
      versionState: terminalCliVersionState(currentVersion, bundledVersion, detectedPath !== null),
    };
  }

  install(): Promise<TerminalCliResult> { return this.mutate(() => this.installFiles()); }
  uninstall(): Promise<TerminalCliResult> { return this.mutate(() => this.uninstallFiles()); }

  private mutate(operation: () => Promise<void>): Promise<TerminalCliResult> {
    const result = this.pending.then(async (): Promise<TerminalCliResult> => {
      try { await operation(); return { ok: true, status: await this.status() }; }
      catch (error) {
        console.warn("[terminal-cli] Installation operation failed", error);
        return { ok: false, error: error instanceof InstallError ? error.code : "filesystem" };
      }
    });
    this.pending = result.then(() => {});
    return result;
  }

  private async removeBlock(path: string): Promise<void> {
    const current = await textFile(path);
    if (current.includes(this.block)) await writeFile(path, current.replace(this.block, ""));
  }

  private async installFiles(): Promise<void> {
    const status = await this.status();
    if (!status.supported) throw new InstallError("unsupported");
    if (!status.bundleAvailable) throw new InstallError("bundle_missing");
    if (this.options.commandTarget && !(await executable(this.options.commandTarget))) throw new InstallError("bundle_missing");
    if (status.conflictPath) throw new InstallError("conflict");
    const previous = await this.record();
    const files = [...new Set([...status.shellFiles, ...(previous?.shellFiles ?? [])])];
    const added: string[] = [];
    for (const path of files) {
      const current = await textFile(path);
      if ((current.includes(START) || current.includes(END)) && !current.includes(this.block)) throw new InstallError("shell_conflict");
    }
    await mkdir(dirname(this.command), { recursive: true });
    await mkdir(dirname(this.recordPath), { recursive: true });
    const oldTarget = previous && await linkTarget(this.command) === previous.target ? previous.target : null;
    const commandTarget = this.options.commandTarget ?? this.options.source.cliPath;
    const temporaryRecord = `${this.recordPath}.${randomUUID()}`;
    try {
      if (oldTarget) await rm(this.command);
      // symlink is exclusive: an intervening file is never overwritten.
      await symlink(commandTarget, this.command);
      for (const path of status.shellFiles) {
        if (!(await textFile(path)).includes(this.block)) {
          await appendFile(path, this.block, { mode: 0o644 });
          added.push(path);
        }
      }
      // Remember every shell file we changed so uninstall works after a shell switch.
      await writeFile(temporaryRecord, JSON.stringify({ target: commandTarget, shellFiles: files }), { mode: 0o600, flag: "wx" });
      await rename(temporaryRecord, this.recordPath);
    } catch (error) {
      for (const path of added) await this.removeBlock(path);
      if (await linkTarget(this.command) === commandTarget) await rm(this.command);
      if (oldTarget && !(await exists(this.command))) await symlink(oldTarget, this.command);
      throw error;
    } finally { await rm(temporaryRecord, { force: true }); }
  }

  private async uninstallFiles(): Promise<void> {
    const record = await this.record();
    if (!record) return;
    // Leave a replacement installed by Homebrew or the user untouched.
    if (await linkTarget(this.command) === record.target) await rm(this.command);
    for (const path of record.shellFiles) await this.removeBlock(path);
    await rm(this.recordPath, { force: true });
  }
}
