#!/usr/bin/env node

import { constants } from "node:fs";
import {
  access,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const skillName = "tutti-ui-system";
const devCacheDirectoryName = ".tutti-ui-system-dev";
const companionFiles = ["AGENTS.md", "ui-system.md"];

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

const targetRoot = resolve(options.cwd, ".codex", "skills");
const targetDirectory = join(targetRoot, skillName);
const sourceRoot = await resolveSourceRoot(options.cwd);
const sourceDirectory = join(sourceRoot, "agent", skillName);

await assertReadableDirectory(sourceDirectory);
await Promise.all(
  companionFiles.map((fileName) =>
    assertReadableFile(join(sourceRoot, fileName))
  )
);
await mkdir(targetRoot, { recursive: true });

if (await pathExists(targetDirectory)) {
  const targetStats = await stat(targetDirectory);

  if (!targetStats.isDirectory()) {
    throw new Error(`Target exists and is not a directory: ${targetDirectory}`);
  }

  if (!options.force) {
    if (await directoriesMatch(sourceRoot, sourceDirectory, targetDirectory)) {
      console.log(
        `tutti-ui-system skill already configured at ${targetDirectory}`
      );
      process.exit(0);
    }

    throw new Error(
      `Target skill already exists with local changes: ${targetDirectory}\n` +
        "Run with --force to replace it."
    );
  }

  await rm(targetDirectory, { recursive: true, force: true });
}

await cp(sourceDirectory, targetDirectory, {
  errorOnExist: false,
  force: true,
  recursive: true
});
await Promise.all(
  companionFiles.map((fileName) =>
    cp(join(sourceRoot, fileName), join(targetDirectory, fileName), {
      errorOnExist: false,
      force: true,
      recursive: false
    })
  )
);

console.log(`Installed tutti-ui-system skill to ${targetDirectory}`);
console.log(
  "Agents can now load it from .codex/skills/tutti-ui-system/SKILL.md"
);

function parseArgs(args) {
  const parsed = {
    cwd: process.cwd(),
    force: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--force") {
      parsed.force = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    if (arg === "--cwd") {
      const cwd = args[index + 1];
      if (!cwd) {
        throw new Error("--cwd requires a directory path");
      }
      parsed.cwd = resolve(cwd);
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return parsed;
}

function printHelp() {
  console.log(`Usage: tutti-ui-system-install-skill [options]

Copies the bundled Tutti UI System skill into the current repository.

Options:
  --cwd <path>  Repository root to configure. Defaults to the current directory.
  --force       Replace an existing .codex/skills/tutti-ui-system directory.
  -h, --help    Show this help message.`);
}

async function assertReadableDirectory(path) {
  await access(path, constants.R_OK);
  const pathStats = await stat(path);

  if (!pathStats.isDirectory()) {
    throw new Error(`Expected directory: ${path}`);
  }
}

async function assertReadableFile(path) {
  await access(path, constants.R_OK);
  const pathStats = await stat(path);

  if (!pathStats.isFile()) {
    throw new Error(`Expected file: ${path}`);
  }
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveSourceRoot(cwd) {
  const devCacheRoot = resolve(cwd, devCacheDirectoryName);
  const devCacheSkillDirectory = join(devCacheRoot, "agent", skillName);

  if (
    (await pathExists(devCacheSkillDirectory)) &&
    (await pathExists(join(devCacheRoot, "AGENTS.md"))) &&
    (await pathExists(join(devCacheRoot, "ui-system.md")))
  ) {
    return devCacheRoot;
  }

  return packageRoot;
}

async function directoriesMatch(sourceRoot, sourceDirectory, rightDirectory) {
  const sourceEntries = await listBundleFiles(sourceRoot, sourceDirectory);
  const leftEntries = sourceEntries.map((entry) => entry.targetRelativePath);
  const rightEntries = await listFiles(rightDirectory, rightDirectory);

  if (leftEntries.length !== rightEntries.length) {
    return false;
  }

  for (let index = 0; index < leftEntries.length; index += 1) {
    if (leftEntries[index] !== rightEntries[index]) {
      return false;
    }

    const leftFile = sourceEntries[index].sourceAbsolutePath;
    const rightFile = join(rightDirectory, rightEntries[index]);

    const [leftContent, rightContent] = await Promise.all([
      readFile(leftFile),
      readFile(rightFile)
    ]);

    if (!leftContent.equals(rightContent)) {
      return false;
    }
  }

  return true;
}

async function listBundleFiles(sourceRoot, sourceDirectory) {
  const skillFiles = await listFiles(sourceDirectory, sourceDirectory);
  const companionEntries = companionFiles.map((fileName) => ({
    sourceAbsolutePath: join(sourceRoot, fileName),
    targetRelativePath: fileName
  }));

  return skillFiles
    .map((relativePath) => ({
      sourceAbsolutePath: join(sourceDirectory, relativePath),
      targetRelativePath: relativePath
    }))
    .concat(companionEntries)
    .sort((left, right) =>
      left.targetRelativePath.localeCompare(right.targetRelativePath)
    );
}

async function listFiles(rootDirectory, directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = join(directory, entry.name);

      if (entry.isDirectory()) {
        return listFiles(rootDirectory, absolutePath);
      }

      if (!entry.isFile()) {
        return [];
      }

      return relative(rootDirectory, absolutePath);
    })
  );

  return files.flat().sort((left, right) => left.localeCompare(right));
}
