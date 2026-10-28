// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseTerminalCliVersion, readTerminalCliVersion, terminalCliVersionState } from "./terminal-cli-version";

describe("terminal CLI version comparison", () => {
  it.each([
    ["0.6.2", "0.7.0", "update_available"],
    ["0.7.9", "0.7.10", "update_available"],
    ["1.9.0", "2.0.0", "update_available"],
    ["0.8.0", "0.7.0", "newer"],
    ["0.7.0", "0.7.0-60-gbcdfa010e", "update_available"],
    ["0.7.0-60-gbcdfa010e", "0.7.0", "newer"],
    ["0.7.0-59-g123456789", "0.7.0-60-gbcdfa010e", "different"],
    ["0.7.0-rc.1", "0.7.0", "different"],
    ["custom-build", "0.7.0", "different"],
  ])("classifies %s against bundled %s as %s", (current, bundled, state) => {
    expect(terminalCliVersionState({ version: current, commit: null }, { version: bundled, commit: null }, true)).toBe(state);
  });

  it("checks revisions even if version labels match and tolerates abbreviated commits", () => {
    const bundled = { version: "0.7.0", commit: "bcdfa010e" };
    expect(terminalCliVersionState({ ...bundled, commit: "abcdef123" }, bundled, true)).toBe("different");
    expect(terminalCliVersionState({ ...bundled, commit: "bcdfa010e123456" }, bundled, true)).toBe("current");
    expect(terminalCliVersionState({ version: "0.7.0", commit: null }, bundled, true)).toBe("current");
  });

  it("does not call failed or unknown probes current", () => {
    const bundled = { version: "0.7.0", commit: null };
    expect(terminalCliVersionState(null, bundled, false)).toBe("not_installed");
    expect(terminalCliVersionState(null, bundled, true)).toBe("unknown");
    expect(terminalCliVersionState(bundled, null, true)).toBe("unknown");
    expect(terminalCliVersionState({ version: "dev", commit: null }, { version: "dev", commit: null }, true)).toBe("unknown");
  });

  it.each(["", "not-json", "null", "[]", '{"version":false}', '{"version":"0.7.0\\nunsafe"}', JSON.stringify({ version: "x".repeat(161) })])("rejects malformed version output %s", (raw) => {
    expect(parseTerminalCliVersion(raw)).toBeNull();
  });

  it("parses the CLI's version JSON without trusting unrelated fields", () => {
    expect(parseTerminalCliVersion('{"version":"v0.7.0","commit":"BCDFA010E","extra":"ignored"}')).toEqual({ version: "0.7.0", commit: "bcdfa010e" });
    expect(parseTerminalCliVersion('{"version":"0.7.0","commit":"unknown"}')).toEqual({ version: "0.7.0", commit: null });
  });
});

describe.skipIf(process.platform === "win32")("bounded version probing", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "multica-version-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("runs only the explicit version command, with paths containing spaces", async () => {
    const bin = join(root, "spaces ' here", "multica");
    await mkdir(join(bin, ".."));
    await writeFile(bin, '#!/bin/sh\n[ "$1 $2 $3" = "version --output json" ] || exit 1\nprintf \'{"version":"0.7.0","commit":"bcdfa010e"}\\n\'\n', { mode: 0o755 });
    expect(await readTerminalCliVersion(bin)).toEqual({ version: "0.7.0", commit: "bcdfa010e" });
    expect(await readTerminalCliVersion(join(root, "missing"))).toBeNull();
  });

  it("bounds hung and oversized version output and handles nonzero exit codes", async () => {
    const bin = join(root, "multica");
    await writeFile(bin, "#!/bin/sh\nexec /bin/sleep 5\n", { mode: 0o755 });
    expect(await readTerminalCliVersion(bin, 50)).toBeNull();
    await writeFile(bin, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(await readTerminalCliVersion(bin)).toBeNull();
    await writeFile(bin, "#!/bin/sh\nexec /usr/bin/yes x\n", { mode: 0o755 });
    expect(await readTerminalCliVersion(bin)).toBeNull();
  });
});
