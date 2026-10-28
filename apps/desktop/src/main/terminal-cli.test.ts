// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, chmod, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TerminalCliInstaller } from "./terminal-cli";

let home: string;
let bundledPath: string;
let env: NodeJS.ProcessEnv;
const execute = promisify(execFile);
const installer = (overrides: Partial<ConstructorParameters<typeof TerminalCliInstaller>[0]> & { bundledPath?: string } = {}) => {
  const { bundledPath: cliPath = bundledPath, ...options } = overrides;
  return new TerminalCliInstaller({ home, source: { kind: "packaged", appPath: join(home, "Multica.app"), cliPath }, platform: "darwin", env, systemBinDirs: [], ...options });
};
async function writeCli(path: string, version = "0.7.0", commit = "bcdfa010e", text = "test-owned-cli") {
  await writeFile(path, `#!/bin/sh\nif [ "$1" = "version" ]; then\nprintf '%s\\n' '${JSON.stringify({ version, commit })}'\nelse\nprintf '%s\\n' '${text}'\nfi\n`, { mode: 0o755 });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "multica-terminal-'-"));
  bundledPath = join(home, "Multica ' Test.app", "resources", "bin", "multica");
  await mkdir(join(bundledPath, ".."), { recursive: true });
  await writeCli(bundledPath);
  env = { SHELL: "/bin/zsh", PATH: join(home, "missing-bin") };
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe.skipIf(process.platform === "win32")("Desktop terminal CLI installation", () => {
  it("installs a shared launcher that follows the next Desktop without reinstalling", async () => {
    const shared = join(home, "runtime-cli");
    await symlink(bundledPath, shared);
    const service = installer({ commandTarget: shared });
    expect(await service.install()).toMatchObject({ ok: true, status: { installed: true } });
    expect(await readlink(join(home, ".local/bin/multica"))).toBe(shared);
    const next = join(home, "next-worktree-cli");
    await writeCli(next, "0.8.0", "abcdef123", "latest-desktop-cli");
    const temporary = join(home, "next-pointer");
    await symlink(next, temporary); await rename(temporary, shared);
    const output = await execute(join(home, ".local/bin/multica"), ["--version"]);
    expect(output.stdout).toBe("latest-desktop-cli\n");
    expect(await service.status()).toMatchObject({ installed: false, bindingState: "other" });
    const latest = installer({ bundledPath: next, commandTarget: shared });
    expect(await latest.status()).toMatchObject({ installed: true, bindingState: "current" });
    await latest.uninstall();
    expect(await readlink(shared)).toBe(next);
  });
  it("installs offline, exposes the bundled CLI in a fresh shell, and uninstalls only its changes", async () => {
    const rc = join(home, ".zshrc");
    const before = "export MY_SETTING=keep\n";
    await writeFile(rc, before);
    const service = installer();
    expect((await service.status()).installed).toBe(false);
    const result = await service.install();
    expect(result).toMatchObject({ ok: true, status: { installed: true, managed: true } });
    expect(await readlink(join(home, ".local/bin/multica"))).toBe(bundledPath);
    const output = await execute("/bin/sh", ["-c", '. "$1"; cd /; command -v multica; multica --version', "test", rc], { env: { PATH: "/usr/bin:/bin" } });
    expect(output.stdout).toBe(`${join(home, ".local/bin/multica")}\ntest-owned-cli\n`);
    await appendFile(rc, "# user edit after install\n");
    expect(await service.uninstall()).toMatchObject({ ok: true, status: { installed: false, managed: false } });
    expect(await readFile(rc, "utf8")).toBe(`${before}# user edit after install\n`);
    await expect(readlink(join(home, ".local/bin/multica"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is idempotent under repeated and concurrent install clicks", async () => {
    const service = installer();
    const results = await Promise.all([service.install(), service.install()]);
    expect(results.every((result) => result.ok)).toBe(true);
    await service.install();
    expect((await readFile(join(home, ".zshrc"), "utf8")).match(/>>> Multica Desktop CLI >>>/g)).toHaveLength(1);
  });

  it("honors uninstall requests that arrive while installation is pending", async () => {
    const service = installer();
    const installed = service.install();
    const removed = service.uninstall();
    expect(await installed).toMatchObject({ ok: true, status: { installed: true } });
    expect(await removed).toMatchObject({ ok: true, status: { installed: false } });
    expect(await readFile(join(home, ".zshrc"), "utf8")).toBe("");
  });

  it("supports bash login and interactive shells and preserves symlinked dotfiles", async () => {
    const actual = join(home, "bash-config");
    await writeFile(actual, "# keep config\n");
    await symlink(actual, join(home, ".bashrc"));
    await writeFile(join(home, ".profile"), "# login\n");
    const service = installer({ env: { ...env, SHELL: "/bin/bash" }, platform: "linux" });
    expect(await service.install()).toMatchObject({ ok: true });
    const state = await service.status();
    expect(state.shellFiles).toEqual([join(home, ".bashrc"), join(home, ".profile")]);
    for (const path of state.shellFiles) {
      const result = await execute("/bin/bash", ["--noprofile", "--norc", "-c", '. "$1"; multica --version', "test", path], { env: { PATH: "/usr/bin:/bin" } });
      expect(result.stdout).toBe("test-owned-cli\n");
    }
    await service.uninstall();
    expect(await readlink(join(home, ".bashrc"))).toBe(actual);
    expect(await readFile(actual, "utf8")).toBe("# keep config\n");
  });

  it("honors ZDOTDIR and cleans up after changing shells", async () => {
    const config = join(home, "custom-zsh");
    await mkdir(config);
    const service = installer({ env: { ...env, ZDOTDIR: config } });
    expect(await service.install()).toMatchObject({ ok: true });
    expect((await service.status()).shellFiles).toEqual([join(config, ".zshrc")]);
    const bash = installer({ env: { ...env, SHELL: "/bin/bash" } });
    expect(await bash.install()).toMatchObject({ ok: true });
    await bash.uninstall();
    expect(await readFile(join(config, ".zshrc"), "utf8")).toBe("");
  });

  it("detects an older external CLI and installs an update alongside it without replacing it", async () => {
    const bin = join(home, "brew-bin");
    await mkdir(bin);
    await writeCli(join(bin, "multica"), "0.6.2", "123456789", "old installation");
    const before = await readFile(join(bin, "multica"), "utf8");
    const service = installer({ env: { ...env, PATH: bin } });
    expect(await service.status()).toMatchObject({ detectedPath: join(bin, "multica"), versionState: "update_available", currentVersion: { version: "0.6.2" }, bundledVersion: { version: "0.7.0" }, conflictPath: null });
    expect(await service.install()).toMatchObject({ ok: true, status: { versionState: "current", installed: true } });
    expect(await readFile(join(bin, "multica"), "utf8")).toBe(before);
    expect(await service.uninstall()).toMatchObject({ ok: true, status: { versionState: "update_available", currentVersion: { version: "0.6.2" } } });
  });

  it.each([false, true])("preserves an unmanaged local command, including a broken symlink (link=%s)", async (link) => {
    const command = join(home, ".local/bin/multica");
    await mkdir(join(command, ".."), { recursive: true });
    if (link) await symlink(join(home, "gone"), command);
    else await writeFile(command, "user file");
    expect(await installer().install()).toEqual({ ok: false, error: "conflict" });
    if (link) expect(await readlink(command)).toBe(join(home, "gone"));
    else expect(await readFile(command, "utf8")).toBe("user file");
  });

  it("repairs a moved app and follows updates at the same bundle path", async () => {
    const service = installer();
    expect(await service.install()).toMatchObject({ ok: true });
    await writeCli(bundledPath, "0.8.0", "abcdef123", "new-version");
    const output = await execute(join(home, ".local/bin/multica"), ["--version"]);
    expect(output.stdout).toBe("new-version\n");
    expect(await service.status()).toMatchObject({ versionState: "current", currentVersion: { version: "0.8.0" }, bundledVersion: { version: "0.8.0" } });
    const moved = join(home, "moved-cli");
    await rename(bundledPath, moved);
    const repaired = installer({ bundledPath: moved });
    expect((await repaired.status()).installed).toBe(false);
    expect(await repaired.install()).toMatchObject({ ok: true, status: { installed: true } });
    expect(await readlink(join(home, ".local/bin/multica"))).toBe(moved);
  });

  it("rolls back the link and prior shell changes if setup fails", async () => {
    await writeFile(join(home, ".bashrc"), "# keep\n");
    await symlink(join(home, "missing", "profile"), join(home, ".bash_profile"));
    const service = installer({ env: { ...env, SHELL: "/bin/bash" } });
    expect(await service.install()).toEqual({ ok: false, error: "filesystem" });
    expect(await readFile(join(home, ".bashrc"), "utf8")).toBe("# keep\n");
    await expect(readlink(join(home, ".local/bin/multica"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never deletes a command replaced by the user after installation", async () => {
    const service = installer();
    await service.install();
    const path = join(home, ".local/bin/multica");
    await rm(path);
    await writeFile(path, "replacement");
    await service.uninstall();
    expect(await readFile(path, "utf8")).toBe("replacement");
  });

  it("repairs an accidentally removed command without duplicating PATH configuration", async () => {
    const service = installer();
    await service.install();
    await rm(join(home, ".local/bin/multica"));
    expect(await service.install()).toMatchObject({ ok: true, status: { installed: true } });
    expect((await readFile(join(home, ".zshrc"), "utf8")).match(/>>> Multica Desktop CLI >>>/g)).toHaveLength(1);
  });

  it("offers an update when a managed link still points to an older app", async () => {
    const older = installer();
    await older.install();
    const next = join(home, "new-app-cli");
    await writeCli(next, "0.8.0", "abcdef123");
    const upgraded = installer({ bundledPath: next });
    expect(await upgraded.status()).toMatchObject({ managed: true, installed: false, versionState: "update_available", currentVersion: { version: "0.7.0" } });
    expect(await upgraded.install()).toMatchObject({ ok: true, status: { installed: true, versionState: "current", currentVersion: { version: "0.8.0" } } });
  });

  it("checks PATH order when the managed shell configuration has been removed", async () => {
    const bin = join(home, "other-bin");
    await mkdir(bin);
    await writeCli(join(bin, "multica"), "0.6.2");
    const service = installer({ env: { ...env, PATH: bin } });
    await service.install();
    await writeFile(join(home, ".zshrc"), "# user reset\n");
    expect(await service.status()).toMatchObject({ installed: false, managed: true, detectedPath: join(bin, "multica"), currentVersion: { version: "0.6.2" }, versionState: "update_available" });
  });

  it("does not install an executable whose version output is invalid", async () => {
    await writeFile(bundledPath, "#!/bin/sh\necho invalid\n", { mode: 0o755 });
    expect(await installer().status()).toMatchObject({ bundleAvailable: false, versionState: "unknown", bundledVersion: null });
    expect(await installer().install()).toEqual({ ok: false, error: "bundle_missing" });
  });

  it("binds an identical-version dev CLI to the selected worktree and follows atomic rebuilds", async () => {
    const source = { kind: "development" as const, appPath: join(home, "worktree-a/apps/desktop"), cliPath: bundledPath };
    const first = installer({ source });
    expect(await first.install()).toMatchObject({ ok: true, status: { bindingState: "current", source } });
    const secondCli = join(home, "worktree-b-cli");
    await writeCli(secondCli);
    const secondSource = { kind: "development" as const, appPath: join(home, "worktree-b/apps/desktop"), cliPath: secondCli };
    const second = installer({ source: secondSource });
    expect(await second.status()).toMatchObject({ installed: false, versionState: "current", bindingState: "other", source: secondSource });
    expect(await second.install()).toMatchObject({ ok: true, status: { installed: true, bindingState: "current" } });
    const replacement = join(home, "next-cli");
    await writeCli(replacement, "0.8.0", "abcdef123");
    await rename(replacement, secondCli);
    expect(await readlink(join(home, ".local/bin/multica"))).toBe(secondCli);
    expect(await second.status()).toMatchObject({ installed: true, bindingState: "current", versionState: "current", currentVersion: { version: "0.8.0" } });
    expect(await first.status()).toMatchObject({ installed: false, bindingState: "other" });
  });

  it("refuses edited PATH blocks, unsupported shells, and missing bundled binaries", async () => {
    await writeFile(join(home, ".zshrc"), "# >>> Multica Desktop CLI >>>\n# custom\n");
    expect(await installer().install()).toEqual({ ok: false, error: "shell_conflict" });
    expect(await installer({ env: { ...env, SHELL: "/bin/fish" } }).install()).toEqual({ ok: false, error: "unsupported" });
    expect(await installer({ platform: "win32" }).install()).toEqual({ ok: false, error: "unsupported" });
    await chmod(bundledPath, 0o644);
    expect(await installer().install()).toEqual({ ok: false, error: "bundle_missing" });
  });
});
