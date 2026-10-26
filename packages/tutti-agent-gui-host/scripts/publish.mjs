import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function publishAgentGuiBuild(source, target) {
  const entry = await readFile(join(source, "index.html"));
  await mkdir(target, { recursive: true });
  // Open documents can still request old hashed chunks, fonts and images.
  for (const name of await readdir(source)) {
    if (name !== "index.html") await cp(join(source, name), join(target, name), { recursive: true });
  }
  const temporaryEntry = join(target, `.index-${randomUUID()}.html`);
  try {
    await writeFile(temporaryEntry, entry);
    await rename(temporaryEntry, join(target, "index.html"));
  } finally { await rm(temporaryEntry, { force: true }); }
}
