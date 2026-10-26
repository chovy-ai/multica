import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { publishAgentGuiBuild } from "./publish.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const outputRoot = join(packageRoot, "dist");
const lockRoot = join(packageRoot, ".build-lock");
const fingerprintFile = join(packageRoot, ".build-fingerprint");
const themeTokensFile = join(packageRoot, ".multica-tokens.css");
const publicRoots = [
  join(repositoryRoot, "apps/desktop/src/renderer/public/tutti-agent-gui"),
  join(repositoryRoot, "apps/web/public/tutti-agent-gui"),
];

async function acquireLock() {
  const deadline = Date.now() + 180_000;
  while (true) {
    try {
      await mkdir(lockRoot);
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const age = Date.now() - (await stat(lockRoot).catch(() => null))?.mtimeMs;
      if (age > 180_000) {
        await rm(lockRoot, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error("Timed out waiting for the Agent GUI build");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

async function fingerprint() {
  const hash = createHash("sha256");
  async function visit(path) {
    const entry = await stat(path);
    if (entry.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        if (["node_modules", "dist", ".git"].includes(name)) continue;
        await visit(join(path, name));
      }
    } else {
      hash.update(`${relative(repositoryRoot, path)}:${entry.size}:${entry.mtimeMs}\n`);
    }
  }
  await visit(join(packageRoot, "src"));
  await visit(join(repositoryRoot, "packages/ui/styles"));
  await visit(join(repositoryRoot, "vendor/tutti/packages"));
  for (const name of ["index.html", "package.json", "vite.config.ts", "scripts/build.mjs", "scripts/publish.mjs"]) {
    await visit(join(packageRoot, name));
  }
  for (const name of ["package.json", "pnpm-lock.yaml", "vendor/tutti/source-manifest.json", "vendor/tutti/LICENSE", "vendor/tutti/NOTICE", "vendor/tutti/packages/ui/system/NOTICE"]) {
    await visit(join(repositoryRoot, name));
  }
  return hash.digest("hex");
}

async function prepareThemeTokens() {
  const source = await readFile(fileURLToPath(import.meta.resolve("@multica/ui/styles/tokens.css")), "utf8");
  const rootSelector = /^:root(?=\s*\{)/gm;
  const darkSelector = /^\.dark(?=\s*\{)/gm;
  if ([...source.matchAll(rootSelector)].length !== 1 || [...source.matchAll(darkSelector)].length !== 1) {
    throw new Error("The shared Multica palette must contain one :root and one .dark rule");
  }
  // Retain the public token values and Tailwind directives verbatim. Only
  // strengthen the palette scopes above the source :root[data-theme] rules.
  const content = "/* Generated from @multica/ui/styles/tokens.css; do not edit. */\n"
    + source.replace(rootSelector, "html.multica-agent-gui[data-theme]")
      .replace(darkSelector, "html.multica-agent-gui[data-theme].dark");
  if (await readFile(themeTokensFile, "utf8").catch(() => null) !== content) {
    await writeFile(themeTokensFile, content);
  }
}

await acquireLock();
try {
  await prepareThemeTokens();
  const current = await fingerprint();
  const previous = await readFile(fingerprintFile, "utf8").catch(() => null);
  const hasOutput = await stat(join(outputRoot, "index.html")).then(() => true, () => false);
  if (previous !== current || !hasOutput) {
    const { build } = await import("vite");
    await build({ configFile: join(packageRoot, "vite.config.ts") });
    await writeFile(fingerprintFile, current);
  }
  const licenses = join(outputRoot, "licenses/tutti");
  await mkdir(licenses, { recursive: true });
  await cp(join(repositoryRoot, "vendor/tutti/LICENSE"), join(licenses, "LICENSE"));
  await cp(join(repositoryRoot, "vendor/tutti/NOTICE"), join(licenses, "NOTICE"));
  await cp(join(repositoryRoot, "vendor/tutti/packages/ui/system/NOTICE"), join(licenses, "UI_SYSTEM_NOTICE"));
  const previewLicenses = join(outputRoot, "licenses/html-preview");
  await mkdir(previewLicenses, { recursive: true });
  await cp(join(dirname(fileURLToPath(import.meta.resolve("chart.js"))), "../LICENSE.md"), join(previewLicenses, "Chart.js-LICENSE.md"));
  await cp(join(dirname(fileURLToPath(import.meta.resolve("d3"))), "../LICENSE"), join(previewLicenses, "D3-LICENSE"));
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "vendor/tutti/source-manifest.json"), "utf8"));
  await writeFile(join(licenses, "provenance.json"), `${JSON.stringify(manifest.upstream, null, 2)}\n`);
  for (const target of publicRoots) {
    await publishAgentGuiBuild(outputRoot, target);
  }
} finally {
  await rm(lockRoot, { recursive: true, force: true });
}
