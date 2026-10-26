import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const vendorRoot = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(vendorRoot, "source-manifest.json");
const sourceCommit = "207beeea554435618dffd3b579d0ffe112b065c4";
const packagePaths = [
  "packages/agent/gui",
  "packages/agent/activity-core",
  "packages/analytics/core",
  "packages/browser/workbench-node",
  "packages/connector/contracts",
  "packages/connector/renderer",
  "packages/ui/i18n-runtime",
  "packages/ui/react-hooks",
  "packages/ui/rich-text",
  "packages/ui/system",
  "packages/workbench/snapshot",
  "packages/workbench/surface",
  "packages/workspace/external-core",
  "packages/workspace/file-manager",
  "packages/workspace/file-preview",
  "packages/workspace/file-reference",
  "packages/workspace/issue-manager",
  "packages/workspace/user-project",
  "packages/clients/tuttid-ts",
  "packages/events/protocol",
  "packages/events/stream-core",
  "packages/configs/tsconfig",
];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

if (process.argv[2] === "--verify") {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const entry of [...manifest.files, ...manifest.metadataOverlays]) {
    const content = await readFile(join(vendorRoot, entry.vendorPath));
    if (sha256(content) !== entry.sha256) {
      throw new Error(`Vendored file differs from manifest: ${entry.vendorPath}`);
    }
  }
  console.log(`Verified ${manifest.files.length} unchanged upstream files and ${manifest.metadataOverlays.length} package metadata overlays at ${manifest.upstream.commit}.`);
} else {
  if (!process.argv[2]) throw new Error("Usage: node vendor/tutti/sync.mjs <upstream-checkout> | --verify");
  const sourceRoot = resolve(process.argv[2]);
  const git = (...args) => execFileSync("git", ["-C", sourceRoot, ...args], { encoding: "utf8" });
  if (git("rev-parse", "HEAD").trim() !== sourceCommit) {
    throw new Error(`Expected upstream commit ${sourceCommit}.`);
  }
  if (git("status", "--porcelain", "--", ...packagePaths, "LICENSE", "pnpm-lock.yaml").trim()) {
    throw new Error("The upstream package closure must be clean before vendoring.");
  }

  // Read the importer scalars needed from this pinned pnpm v9 lockfile. The
  // original lockfile is retained as provenance, not installed as a workspace.
  const sourceLock = git("cat-file", "blob", `${sourceCommit}:pnpm-lock.yaml`);
  const importerVersions = new Map();
  let importer;
  let section;
  let dependency;
  let inImporters = false;
  for (const line of sourceLock.split("\n")) {
    if (line === "importers:") { inImporters = true; continue; }
    if (inImporters && /^[^\s]/.test(line)) break;
    if (!inImporters) continue;
    const importerMatch = line.match(/^  ([^ ].*?):(?: \{\})?$/);
    if (importerMatch) {
      importer = importerMatch[1];
      importerVersions.set(importer, {});
      continue;
    }
    const sectionMatch = line.match(/^    (dependencies|devDependencies|optionalDependencies):$/);
    if (sectionMatch) { section = sectionMatch[1]; continue; }
    const dependencyMatch = line.match(/^      (.+):$/);
    if (dependencyMatch) { dependency = dependencyMatch[1].replace(/^['"]|['"]$/g, ""); continue; }
    const versionMatch = line.match(/^        version: (.+)$/);
    if (versionMatch && importer && section && dependency) {
      const records = importerVersions.get(importer);
      records[section] ??= {};
      records[section][dependency] = versionMatch[1].replace(/^['"]|['"]$/g, "").split("(")[0];
    }
  }

  const files = [];
  const omittedFiles = [];
  const metadataOverlays = [];
  const tracked = git("ls-files", "-z", "--", ...packagePaths, "LICENSE", "NOTICE", "pnpm-lock.yaml").split("\0").filter(Boolean).sort();
  if (tracked.some((path) => path.includes("\n"))) throw new Error("Unexpected newline in an upstream file path.");
  // Git blobs preserve canonical bytes even when a Windows checkout uses
  // automatic CRLF conversion. Batch reads also preserve binary assets.
  const blobs = execFileSync("git", ["-C", sourceRoot, "cat-file", "--batch"], {
    input: `${tracked.map((path) => `${sourceCommit}:${path}`).join("\n")}\n`,
    maxBuffer: 128 * 1024 * 1024,
  });
  let offset = 0;
  for (const sourcePath of tracked) {
    const headerEnd = blobs.indexOf(10, offset);
    const header = blobs.subarray(offset, headerEnd).toString("ascii");
    const match = /^[a-f0-9]+ blob (\d+)$/.exec(header);
    if (!match) throw new Error(`Cannot read the upstream blob for ${sourcePath}.`);
    const size = Number(match[1]);
    const content = blobs.subarray(headerEnd + 1, headerEnd + 1 + size);
    offset = headerEnd + 1 + size + 1;
    if (/(^|\/)(AGENTS|CLAUDE)\.md$/.test(sourcePath)) {
      omittedFiles.push(sourcePath);
      continue;
    }
    const vendorPath = sourcePath.endsWith("/package.json")
      ? sourcePath.replace(/package\.json$/, "package.upstream.json")
      : sourcePath === "pnpm-lock.yaml" ? "pnpm-lock.upstream.yaml" : sourcePath;
    const destination = join(vendorRoot, vendorPath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
    files.push({ sourcePath, vendorPath, bytes: content.length, sha256: sha256(content) });
  }

  for (const packagePath of packagePaths) {
    const upstream = JSON.parse(await readFile(join(vendorRoot, packagePath, "package.upstream.json"), "utf8"));
    const versions = importerVersions.get(packagePath) ?? {};
    const pinnedVersion = (name) => {
      const value = versions.dependencies?.[name] ?? versions.devDependencies?.[name];
      if (!value || value.startsWith("link:")) throw new Error(`Missing locked npm version for ${packagePath}: ${name}`);
      return value;
    };
    const overlay = { ...upstream, private: true };
    delete overlay.scripts;
    delete overlay.devDependencies;
    delete overlay.publishConfig;
    delete overlay.bin;
    overlay.dependencies = Object.fromEntries(Object.entries(upstream.dependencies ?? {}).map(([name, version]) => [
      name,
      version.startsWith("workspace:") ? version : pinnedVersion(name),
    ]));
    // Each independent UI document gets the original, coherent peer baseline.
    // Optional native platforms are not part of this web renderer vendoring.
    for (const name of Object.keys(upstream.peerDependencies ?? {})) {
      if (upstream.peerDependenciesMeta?.[name]?.optional && name !== "react-dom") continue;
      overlay.dependencies[name] ??= pinnedVersion(name);
    }
    if (overlay.peerDependencies?.["react-native"]) {
      overlay.peerDependencies = { ...overlay.peerDependencies };
      overlay.peerDependenciesMeta = { ...overlay.peerDependenciesMeta };
      delete overlay.peerDependencies["react-native"];
      delete overlay.peerDependenciesMeta["react-native"];
    }
    const typeDependencies = Object.entries(upstream.devDependencies ?? {})
      .filter(([name]) => name.startsWith("@types/"));
    if (typeDependencies.length) overlay.devDependencies = Object.fromEntries(typeDependencies.map(([name]) => [name, pinnedVersion(name)]));
    if (packagePath === "packages/agent/gui") {
      overlay.dependencies["@tutti-os/client-tuttid-ts"] = "workspace:*";
      overlay.dependencies["@tutti-os/event-protocol"] = "workspace:*";
    }
    if (packagePath === "packages/ui/rich-text") {
      // RichTextTriggerEditor imports these at runtime; upstream lists them
      // under development dependencies because its monorepo provides them.
      for (const name of ["@tiptap/extension-document", "@tiptap/extension-hard-break", "@tiptap/extension-paragraph", "@tiptap/extension-text"]) {
        overlay.dependencies[name] = pinnedVersion(name);
      }
      overlay.dependencies["@tiptap/pm"] = "3.23.6";
    }
    const vendorPath = `${packagePath}/package.json`;
    const content = `${JSON.stringify(overlay, null, 2)}\n`;
    await writeFile(join(vendorRoot, vendorPath), content);
    metadataOverlays.push({ vendorPath, upstreamManifest: `${packagePath}/package.upstream.json`, sha256: sha256(content) });
  }

  const manifest = {
    upstream: { repository: "https://github.com/tutti-os/tutti", commit: sourceCommit, license: "Apache-2.0" },
    packagePaths,
    metadataPolicy: "Source exports and UI files are unchanged. Local private manifests omit upstream build/test tooling, pin real web dependencies and required peers to upstream lock resolutions, retain only type development dependencies, and omit the optional React Native peer. Agent GUI adds its existing type-only client and event contracts as local dependencies. Rich Text promotes four runtime-imported Tiptap extensions from upstream development dependencies and supplies their ProseMirror peer. Original manifests are preserved as package.upstream.json.",
    omittedPolicy: "Agent instruction files are omitted because this is code and asset vendoring, not an upstream repository checkout.",
    omittedFiles,
    files,
    metadataOverlays,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Vendored ${files.length} upstream files across ${packagePaths.length} packages at ${sourceCommit}.`);
}
