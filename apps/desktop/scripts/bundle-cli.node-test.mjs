import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const fullRevision = "a".repeat(40);
const scriptDir = fileURLToPath(new URL(".", import.meta.url));

test("release packaging rejects missing Go even when a stale CLI artifact exists", () => {
  const root = mkdtempSync(join(tmpdir(), "multica-bundle-required-"));
  try {
    const scripts = join(root, "apps", "desktop", "scripts");
    const binary = join(root, "server", "bin", "darwin-arm64", "multica");
    const bin = join(root, "fake-bin");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(join(binary, ".."), { recursive: true });
    mkdirSync(bin);
    writeFileSync(binary, "stale CLI");
    for (const name of ["bundle-cli.mjs", "package.mjs"]) copyFileSync(join(scriptDir, name), join(scripts, name));
    fakeExecutable(join(bin, "go"), "process.exit(1);\n");
    assert.throws(() => execFileSync(process.execPath, [join(scripts, "bundle-cli.mjs"), "--require-build", "--target-platform", "darwin", "--target-arch", "arm64"], { env: { PATH: bin }, stdio: "pipe" }), /Desktop dev and packaging require Go/);
    assert.equal(readFileSync(binary, "utf8"), "stale CLI");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function fakeExecutable(path, source) {
  writeFileSync(path, `#!${process.execPath}\n${source}`, { mode: 0o755 });
}

function devFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "multica-dev-binding-")));
  const scripts = join(root, "apps", "desktop", "scripts");
  const bin = join(root, "fake-bin");
  const record = join(root, "steps.jsonl");
  const desktop = join(root, "apps", "desktop");
  const destination = join(desktop, "resources", "bin", "multica");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin);
  mkdirSync(join(root, "server"));
  mkdirSync(join(desktop, "resources", "bin"), { recursive: true });
  writeFileSync(destination, "previous cli");
  for (const name of ["dev.mjs", "bundle-cli.mjs", "package.mjs", "claude-login-env.mjs", "worktree-dev-env.mjs"]) copyFileSync(join(scriptDir, name), join(scripts, name));
  fakeExecutable(join(bin, "git"), `const args=process.argv.slice(2); console.log(args[0] === 'describe' ? 'v9.9.9' : '${fullRevision}');`);
  fakeExecutable(join(bin, "go"), `
const args=process.argv.slice(2);
if (args[0] === 'version') console.log('go version fake');
else {
  const fs=await import('node:fs');
  fs.appendFileSync(process.env.TEST_STEP_RECORD, JSON.stringify({step:'go',cwd:process.cwd(),args})+'\\n');
  fs.writeFileSync(args[args.indexOf('-o')+1], 'new cli');
}
`);
  fakeExecutable(join(bin, "codesign"), `
const fs=await import('node:fs');
fs.appendFileSync(process.env.TEST_STEP_RECORD, JSON.stringify({step:'sign',previous:fs.readFileSync(process.env.TEST_CLI_DEST,'utf8'),next:fs.readFileSync(process.argv.at(-1),'utf8')})+'\\n');
`);
  writeFileSync(join(scripts, "brand-dev-electron.mjs"), `import fs from 'node:fs'; fs.appendFileSync(process.env.TEST_STEP_RECORD, JSON.stringify({step:'brand',cwd:process.cwd()})+'\\n');`);
  fakeExecutable(join(bin, "electron-vite"), `const fs=await import('node:fs'); fs.appendFileSync(process.env.TEST_STEP_RECORD, JSON.stringify({step:'electron',cwd:process.cwd(),args:process.argv.slice(2)})+'\\n');`);
  return { root, scripts, bin, record, desktop, destination, env: { PATH: bin, TEST_STEP_RECORD: record, TEST_CLI_DEST: destination } };
}

test("dev startup builds its CLI before Electron and stays in its own worktree from another cwd", () => {
  const f = devFixture();
  try {
    const foreign = join(f.root, "foreign");
    mkdirSync(foreign);
    execFileSync(process.execPath, [join(f.scripts, "dev.mjs"), "--cloud", "--claude-login"], { cwd: foreign, env: f.env, stdio: "pipe" });
    const steps = readFileSync(f.record, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(steps[0].step, "go");
    assert.equal(steps[0].cwd, join(f.root, "server"));
    assert.equal(steps.find((entry) => entry.step === "brand").cwd, f.desktop);
    assert.deepEqual(steps.at(-1), { step: "electron", cwd: f.desktop, args: ["dev", "--mode", "production"] });
    assert.equal(readFileSync(f.destination, "utf8"), "new cli");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("dev startup refuses a stale CLI when Go is unavailable and never launches Electron", () => {
  const f = devFixture();
  try {
    fakeExecutable(join(f.bin, "go"), "process.exit(1);");
    assert.throws(() => execFileSync(process.execPath, [join(f.scripts, "dev.mjs")], { env: f.env, stdio: "pipe" }), /Desktop dev and packaging require Go/);
    assert.equal(existsSync(f.record), false);
    assert.equal(readFileSync(f.destination, "utf8"), "previous cli");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a rebuild publishes atomically so existing command links stay usable", { skip: process.platform !== "darwin" }, () => {
  const f = devFixture();
  try {
    const command = join(f.root, "global-command");
    symlinkSync(f.destination, command);
    execFileSync(process.execPath, [join(f.scripts, "bundle-cli.mjs"), "--require-build"], { env: f.env, stdio: "pipe" });
    const steps = readFileSync(f.record, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(steps.find((entry) => entry.step === "sign"), { step: "sign", previous: "previous cli", next: "new cli" });
    assert.equal(readFileSync(command, "utf8"), "new cli");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const [platform, arch, goos, goarch, foreignCaller] of [
  ["darwin", "arm64", "darwin", "arm64", false],
  ["linux", "x64", "linux", "amd64", false],
  ["win32", "arm64", "windows", "arm64", false],
  ["darwin", "arm64", "darwin", "arm64", true],
  ["linux", "x64", "linux", "amd64", true],
  ["win32", "arm64", "windows", "arm64", true],
]) {
  for (const missingRevision of [false, true]) {
    test(`bundled ${platform}/${arch} preserves source-root commit (missing=${missingRevision}, foreignCaller=${foreignCaller})`, () => {
      const root = mkdtempSync(join(tmpdir(), "multica-bundle-commit-"));
      try {
        const scripts = join(root, "apps", "desktop", "scripts");
        const bin = join(root, "fake-bin");
        const record = join(root, "build.json");
        const caller = join(root, "foreign-caller");
        mkdirSync(scripts, { recursive: true });
        mkdirSync(bin);
        mkdirSync(join(root, "server"));
        mkdirSync(caller);
        for (const name of ["bundle-cli.mjs", "package.mjs"]) {
          copyFileSync(join(scriptDir, name), join(scripts, name));
        }
        fakeExecutable(join(bin, "git"), `
const args = process.argv.slice(2);
if (args[0] === "describe") console.log("v9.9.9");
else if (args.join(" ") === "rev-parse --short HEAD") console.log("abc1234");
else if (args.join(" ") === "rev-parse HEAD") {
  if (process.env.TEST_MISSING_REVISION === "true") process.exit(1);
  console.log(process.cwd() === process.env.TEST_SOURCE_ROOT ? ${JSON.stringify(fullRevision)} : "b".repeat(40));
} else process.exit(2);
`);
        fakeExecutable(join(bin, "go"), `
const args = process.argv.slice(2);
if (args[0] === "version") console.log("go version go1.27.1 fake/fake");
else if (args[0] === "build") {
  const fs = await import("node:fs");
  fs.writeFileSync(process.env.TEST_BUILD_RECORD, JSON.stringify({args, goos:process.env.GOOS, goarch:process.env.GOARCH, cgo:process.env.CGO_ENABLED}));
  fs.writeFileSync(args[args.indexOf("-o") + 1], "fake artifact");
} else process.exit(2);
`);
        fakeExecutable(join(bin, "codesign"), "process.exit(0);\n");
        execFileSync(process.execPath, [join(scripts, "bundle-cli.mjs"), "--target-platform", platform, "--target-arch", arch], {
          cwd: foreignCaller ? caller : root,
          env: { PATH: bin, HOME: root, TEST_SOURCE_ROOT: realpathSync(root), TEST_BUILD_RECORD: record, TEST_MISSING_REVISION: String(missingRevision) },
          stdio: "pipe",
        });
        const build = JSON.parse(readFileSync(record, "utf8"));
        const flags = build.args[build.args.indexOf("-ldflags") + 1].split(" ");
        assert.ok(flags.includes("main.version=9.9.9"));
        assert.ok(flags.includes("main.commit=abc1234"));
        assert.ok(flags.includes(`main.buildCommit=${missingRevision ? "unknown" : fullRevision}`));
        assert.equal(build.goos, goos);
        assert.equal(build.goarch, goarch);
        assert.equal(build.cgo, "0");
        const artifact = platform === "win32" ? "multica.exe" : "multica";
        assert.equal(readFileSync(join(root, "apps", "desktop", "resources", "bin", artifact), "utf8"), "fake artifact");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
