import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { problem, VerificationError } from "../host/problem.js";
import { launch, run, type RunningProcess } from "./process.js";
import type { prepareToolchain } from "./toolchain.js";

/** The development variant's identity, fixed by apps/mobile/app.config.ts. */
export const MOBILE_BUNDLE_ID = "ai.multica.mobile.dev";
/** Simulators created by the host carry this name prefix and nothing else does. */
export const SIMULATOR_PREFIX = "multica-verification-";

type Tools = Awaited<ReturnType<typeof prepareToolchain>>;
/**
 * A launchd-started host passes only PATH and HOME. Without a UTF-8 locale
 * CocoaPods aborts and simctl pbcopy cannot decode non-ASCII text.
 */
const utf8 = { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };

export function exec(
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number; signal?: AbortSignal } = {},
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) =>
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeout ?? 60_000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "buffer",
        env: { ...process.env, ...utf8 },
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        const message = stderr.toString("utf8").trim();
        if (error)
          reject(
            new VerificationError(
              problem(
                "sourceUnavailable",
                `${command} ${args[0] ?? ""} failed${message ? `: ${message.slice(-600)}` : ""}`,
                "inspect",
              ),
            ),
          );
        else resolve({ stdout, stderr: message });
      },
    ),
  );
}
const simctl = async (args: string[], signal?: AbortSignal, timeout?: number) =>
  (await exec("xcrun", ["simctl", ...args], { signal, timeout })).stdout
    .toString("utf8")
    .trim();

const runtimesSchema = z.object({
  runtimes: z.array(
    z
      .object({
        identifier: z.string(),
        name: z.string(),
        version: z.string(),
        platform: z.string().optional(),
        isAvailable: z.boolean(),
        supportedDeviceTypes: z
          .array(
            z.object({ identifier: z.string(), name: z.string() }).passthrough(),
          )
          .default([]),
      })
      .passthrough(),
  ),
});

/** Picks the newest available iOS runtime and, on it, the newest iPhone Pro model. */
export function pickSimulatorTarget(list: unknown) {
  const versionKey = (version: string) =>
    version.split(".").map((part) => Number(part) || 0);
  const runtime = runtimesSchema
    .parse(list)
    .runtimes.filter(
      (item) =>
        item.isAvailable && (item.platform ?? item.name).startsWith("iOS"),
    )
    .sort((a, b) => {
      const [x, y] = [versionKey(a.version), versionKey(b.version)];
      for (let i = 0; i < Math.max(x.length, y.length); i++)
        if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
      return 0;
    })[0];
  if (!runtime)
    throw new VerificationError(
      problem(
        "dependencyMissing",
        "No iOS simulator runtime is installed; add one in Xcode → Settings → Components",
        "userAction",
      ),
    );
  const model = (name: string) => Number(/\d+/.exec(name)?.[0] ?? 0);
  const deviceType =
    runtime.supportedDeviceTypes
      .filter((type) => /^iPhone \d+ Pro$/.test(type.name))
      .sort((a, b) => model(b.name) - model(a.name))[0] ??
    runtime.supportedDeviceTypes.find((type) => type.name.startsWith("iPhone"));
  if (!deviceType)
    throw new VerificationError(
      problem(
        "dependencyMissing",
        `The ${runtime.name} runtime supports no iPhone model`,
        "userAction",
      ),
    );
  return {
    runtime: runtime.identifier,
    runtimeName: runtime.name,
    deviceType: deviceType.identifier,
    deviceName: deviceType.name,
  };
}
export async function simulatorTarget(signal?: AbortSignal) {
  return pickSimulatorTarget(
    JSON.parse(await simctl(["list", "runtimes", "-j"], signal)),
  );
}

/** Builds share one compile per native identity; a second caller waits for it. */
const building = new Map<string, Promise<string>>();

/**
 * Returns a simulator Debug build of the mobile dev client, reusing a cached
 * build whose native inputs match. Expo's fingerprint covers native
 * dependencies, config plugins and app config; the device-link framework is
 * gitignored output, so its own source fingerprint joins the key.
 */
export async function devClientBuild(options: {
  checkout: string;
  cacheRoot: string;
  tools: Tools;
  log: string;
  signal: AbortSignal;
}): Promise<{ app: string; key: string; cached: boolean }> {
  const { checkout, tools, log, signal } = options;
  const mobile = join(checkout, "apps/mobile");
  const env = { ...tools.env, ...utf8 };
  await run(tools.node, [tools.pnpm, "run", "build:device-link"], {
    cwd: mobile,
    env,
    log,
    signal,
  });
  // The generated device-link framework is not byte-identical across builds,
  // so it is left out here; its source fingerprint joins the key below.
  const fingerprint = (
    await exec(
      tools.node,
      [
        "-e",
        `require("@expo/fingerprint").createFingerprintAsync(".", ${JSON.stringify({
          platforms: ["ios"],
          ignorePaths: [
            "modules/multica-device-link/ios/MulticaLink.xcframework/**",
            "modules/multica-device-link/ios/.framework-fingerprint",
          ],
        })}).then((result) => process.stdout.write(result.hash))`,
      ],
      { cwd: mobile, timeout: 300_000, signal },
    )
  ).stdout
    .toString("utf8")
    .trim();
  if (!/^[a-f0-9]{40}$/.test(fingerprint))
    throw new VerificationError(
      problem("sourceUnavailable", "The mobile native fingerprint could not be computed", "inspect"),
    );
  // The device-link script's own fingerprint embeds absolute paths, so the
  // same inputs are identified by their committed content instead.
  const deviceLink = (
    await exec(
      "git",
      [
        "rev-parse",
        ...[
          "server/go.mod",
          "server/go.sum",
          "server/mobilelink",
          "server/internal/daemon/mobilediag",
          "server/internal/daemon/p2p",
          "server/internal/tailnetid",
          "apps/mobile/scripts/build-device-link.sh",
        ].map((path) => `HEAD:${path}`),
      ],
      { cwd: checkout, signal },
    )
  ).stdout.toString("utf8");
  const xcode = (await exec("xcodebuild", ["-version"], { signal })).stdout
    .toString("utf8")
    .trim();
  const key = createHash("sha256")
    .update(
      JSON.stringify({ fingerprint, deviceLink, xcode, arch: process.arch }),
    )
    .digest("hex")
    .slice(0, 32);
  const target = join(options.cacheRoot, key),
    app = join(target, "MulticaDev.app");
  if (
    await access(app).then(
      () => true,
      () => false,
    )
  )
    return { app, key, cached: true };
  let pending = building.get(key);
  if (!pending) {
    pending = (async () => {
      const derived = join(options.cacheRoot, `${key}.derived`);
      await rm(derived, { recursive: true, force: true });
      await run(
        tools.node,
        [tools.pnpm, "exec", "expo", "prebuild", "-p", "ios"],
        { cwd: mobile, env: { ...env, CI: "1" }, log, signal },
      );
      await run(
        "xcodebuild",
        [
          // Full xcodebuild output runs past the 16 MiB log cap; warnings and
          // errors still print.
          "-quiet",
          "-workspace",
          "ios/MulticaDev.xcworkspace",
          "-scheme",
          "MulticaDev",
          "-configuration",
          "Debug",
          "-sdk",
          "iphonesimulator",
          "-destination",
          "generic/platform=iOS Simulator",
          "-derivedDataPath",
          derived,
          "build",
        ],
        { cwd: mobile, env, log, signal },
      );
      const staging = `${target}.partial`;
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true });
      await exec(
        "ditto",
        [
          join(derived, "Build/Products/Debug-iphonesimulator/MulticaDev.app"),
          join(staging, "MulticaDev.app"),
        ],
        { signal, timeout: 300_000 },
      );
      await rename(staging, target);
      await rm(derived, { recursive: true, force: true });
      return app;
    })().finally(() => building.delete(key));
    building.set(key, pending);
  }
  return { app: await pending, key, cached: false };
}

/** Builds and starts a registry for this environment only, bound to loopback. */
export async function startP2PServer(options: {
  checkout: string;
  directory: string;
  apiOrigin: string;
  tools: Tools;
  freePort: () => Promise<number>;
  signal: AbortSignal;
}): Promise<{ process: RunningProcess; url: string }> {
  const { checkout, directory, tools, signal } = options;
  const binary = join(directory, "bin/p2p-server");
  await run("go", ["build", "-o", binary, "./cmd/p2p-server"], {
    cwd: join(checkout, "server"),
    env: tools.env,
    log: join(directory, "p2p.log"),
    signal,
  });
  const [port, libp2p] = [await options.freePort(), await options.freePort()];
  const data = join(directory, "p2p");
  await mkdir(data, { recursive: true, mode: 0o700 });
  const child = await launch(binary, [], {
    cwd: data,
    env: {
      ...tools.env,
      MULTICA_API_URL: options.apiOrigin,
      MULTICA_P2P_PUBLIC_IP: "127.0.0.1",
      MULTICA_P2P_LISTEN: `127.0.0.1:${port}`,
      MULTICA_P2P_LIBP2P_PORT: String(libp2p),
      MULTICA_P2P_DB: join(data, "p2p.db"),
      MULTICA_P2P_KEY: join(data, "p2p-server.key"),
    },
    log: join(directory, "p2p.log"),
    signal,
  });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    signal.throwIfAborted();
    try {
      if ((await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) })).ok)
        return { process: child, url };
    } catch {
      /* Not listening yet. */
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  await child.stop();
  throw new VerificationError(
    problem("deadlineExceeded", "The environment's device registry did not start", "inspect"),
  );
}

/** Serves the checkout's mobile JavaScript with the environment's endpoints inlined. */
export async function startMetro(options: {
  checkout: string;
  directory: string;
  port: number;
  tools: Tools;
  publicEnv: Record<string, string>;
  signal: AbortSignal;
}): Promise<RunningProcess> {
  await mkdir(join(options.directory, "tmp"), { recursive: true, mode: 0o700 });
  const child = await launch(
    options.tools.node,
    [
      options.tools.pnpm,
      "exec",
      "expo",
      "start",
      "--dev-client",
      "--localhost",
      "--port",
      String(options.port),
    ],
    {
      cwd: join(options.checkout, "apps/mobile"),
      env: {
        ...options.tools.env,
        ...options.publicEnv,
        CI: "1",
        EXPO_NO_TELEMETRY: "1",
        // --localhost binds "localhost" (often ::1 only) but advertises
        // 127.0.0.1 unless told otherwise; keep the advertised host the same.
        REACT_NATIVE_PACKAGER_HOSTNAME: "localhost",
        // Metro keeps its transform cache under TMPDIR. A private one keeps the
        // inlined test credential out of other projects' caches and stops their
        // cached transforms from carrying another backend's endpoints.
        TMPDIR: join(options.directory, "tmp"),
      },
      log: join(options.directory, "metro.log"),
      signal: options.signal,
    },
  );
  for (let attempt = 0; attempt < 300; attempt++) {
    options.signal.throwIfAborted();
    try {
      const response = await fetch(
        // Metro started with --localhost may listen on ::1 only.
        `http://localhost:${options.port}/status`,
        { signal: AbortSignal.timeout(1000) },
      );
      if ((await response.text()).includes("packager-status:running"))
        return child;
    } catch {
      /* Metro is still starting. */
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  await child.stop();
  throw new VerificationError(
    problem("deadlineExceeded", "Metro did not start for the mobile app", "inspect"),
  );
}

const devMenuOff = [
  "EXDevMenuShowsAtLaunch",
  "EXDevMenuShowFloatingActionButton",
  "EXDevMenuMotionGestureEnabled",
  "EXDevMenuTouchGestureEnabled",
  // Single-key shortcuts ("d", "r") fire when typed text lands outside a field.
  "EXDevMenuKeyCommandsEnabled",
];

export class Simulator {
  constructor(readonly udid: string) {}
  static async create(
    name: string,
    signal: AbortSignal,
  ): Promise<{ simulator: Simulator; target: Awaited<ReturnType<typeof simulatorTarget>> }> {
    const target = await simulatorTarget(signal);
    const udid = await simctl(
      ["create", name, target.deviceType, target.runtime],
      signal,
    );
    if (!/^[0-9A-F-]{36}$/.test(udid))
      throw new VerificationError(
        problem("sourceUnavailable", "simctl did not return a simulator identifier", "inspect"),
      );
    const simulator = new Simulator(udid);
    await simulator.presetSystem(signal);
    return { simulator, target };
  }
  /**
   * Before the first boot iOS takes this from disk: start without a hardware
   * keyboard, so focusing a field shows the software keyboard.
   */
  async presetSystem(signal: AbortSignal) {
    const preferences = join(
      homedir(),
      "Library/Developer/CoreSimulator/Devices",
      this.udid,
      "data/Library/Preferences",
    );
    await mkdir(preferences, { recursive: true });
    const path = join(preferences, "com.apple.keyboard.preferences.plist");
    await exec("plutil", ["-create", "xml1", path], { signal });
    await exec("plutil", ["-insert", "HardwareKeyboardLastSeen", "-bool", "NO", path], { signal });
  }
  /** Returns the simulator's name and state, or null when it no longer exists. */
  async describe(): Promise<{ name: string; state: string } | null> {
    const devices = z
      .object({
        devices: z.record(
          z.string(),
          z.array(
            z.object({ udid: z.string(), name: z.string(), state: z.string() }).passthrough(),
          ),
        ),
      })
      .parse(JSON.parse(await simctl(["list", "devices", "-j"])));
    for (const list of Object.values(devices.devices))
      for (const device of list)
        if (device.udid === this.udid)
          return { name: device.name, state: device.state };
    return null;
  }
  async boot(signal: AbortSignal) {
    await simctl(["boot", this.udid], signal).catch(async (error) => {
      if ((await this.describe())?.state !== "Booted") throw error;
    });
    await simctl(["bootstatus", this.udid, "-b"], signal, 600_000);
  }
  /**
   * Whether focusing a field shows the software keyboard. iOS hides it once it
   * has seen a hardware keyboard, which AXe's key events count as.
   */
  async setSoftwareKeyboard(shown: boolean, signal?: AbortSignal) {
    await simctl(
      [
        "spawn",
        this.udid,
        "defaults",
        "write",
        "com.apple.keyboard.preferences",
        "HardwareKeyboardLastSeen",
        "-bool",
        shown ? "NO" : "YES",
      ],
      signal,
    );
  }
  async install(app: string, signal: AbortSignal) {
    // Right after boot the install service can still refuse with
    // "Failed to create promise"; it accepts the same request moments later.
    for (let attempt = 1; ; attempt++) {
      try {
        await simctl(["install", this.udid, app], signal, 300_000);
        break;
      } catch (error) {
        if (attempt >= 5) throw error;
        await new Promise((done) => setTimeout(done, 3000));
        signal.throwIfAborted();
      }
    }
    // The photo picker and its permission sheet are part of what is verified;
    // pre-granting keeps the system prompt from covering the first attempt.
    await simctl(["privacy", this.udid, "grant", "photos", MOBILE_BUNDLE_ID], signal);
  }
  /**
   * Launches the dev client straight into the environment's Metro. The
   * launcher's --initialUrl argument avoids openurl, which iOS confirms with
   * a system prompt.
   */
  async open(metroPort: number, language?: string, signal?: AbortSignal) {
    await simctl(
      [
        "launch",
        "--terminate-running-process",
        this.udid,
        MOBILE_BUNDLE_ID,
        "--initialUrl",
        `http://localhost:${metroPort}`,
        // Arguments of this form populate NSUserDefaults for this launch:
        // keep the dev menu, its first-run tour, floating button, gestures
        // and shortcuts from covering or intercepting what is being verified.
        ...devMenuOff.flatMap((key) => [`-${key}`, "NO"]),
        "-EXDevMenuIsOnboardingFinished",
        "YES",
        // The app's interface language when one is chosen; otherwise the system's.
        ...(language ? ["-AppleLanguages", `(${language})`] : []),
      ],
      signal,
    );
  }
  async appRunning(): Promise<boolean> {
    const list = await simctl(["spawn", this.udid, "launchctl", "list"]).catch(
      () => "",
    );
    return list.includes(`UIKitApplication:${MOBILE_BUNDLE_ID}`);
  }
  async screenshot(): Promise<Buffer> {
    // simctl takes "-" as a file name, not stdout.
    const directory = await mkdtemp(join(tmpdir(), "multica-verification-shot-"));
    try {
      const file = join(directory, "screen.png");
      await simctl(["io", this.udid, "screenshot", "--type=png", file], undefined, 30_000);
      return await readFile(file);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  /** Replaces the simulator's pasteboard with text. */
  async setPasteboard(text: string) {
    await new Promise<void>((done, fail) => {
      const child = spawn("xcrun", ["simctl", "pbcopy", this.udid], {
        env: { ...process.env, ...utf8 },
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.once("error", fail);
      child.once("exit", (code) =>
        code === 0
          ? done()
          : fail(
              new VerificationError(
                problem("sourceUnavailable", `simctl pbcopy failed: ${stderr.trim().slice(-300)}`, "inspect"),
              ),
            ),
      );
      child.stdin.end(text);
    });
  }
  async setAppearance(value: "light" | "dark") {
    await simctl(["ui", this.udid, "appearance", value]);
  }
  async setContentSize(value: string) {
    await simctl(["ui", this.udid, "content_size", value]);
  }
  async addMedia(paths: string[]) {
    await simctl(["addmedia", this.udid, ...paths], undefined, 120_000);
  }
  async openUrl(url: string) {
    await simctl(["openurl", this.udid, url]);
  }
  /** Deletes only a simulator this host created. */
  async remove() {
    const device = await this.describe();
    if (!device) return;
    if (!device.name.startsWith(SIMULATOR_PREFIX))
      throw new VerificationError(
        problem("forbidden", "The recorded simulator was not created by this host"),
      );
    if (device.state !== "Shutdown")
      await simctl(["shutdown", this.udid]).catch(() => undefined);
    await simctl(["delete", this.udid], undefined, 120_000);
  }
}
