// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readBackgroundTaskOutput } from "./local-background-task-output";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
it("keeps only a bounded tail of a large task output", async () => {
  const root = await mkdtemp(join(tmpdir(), "multica-task-output-")); roots.push(root);
  const path = join(root, "task.output"); await writeFile(path, "x".repeat(40000) + "final result");
  const result = await readBackgroundTaskOutput(path);
  expect(result.output).toHaveLength(32768); expect(result.output).toMatch(/final result$/); expect(result.outputTruncated).toBe(true);
});
it("tolerates a missing output file and does not treat directories as output", async () => {
  const root = await mkdtemp(join(tmpdir(), "multica-task-output-")); roots.push(root);
  expect(await readBackgroundTaskOutput(join(root, "missing"))).toEqual({});
  expect(await readBackgroundTaskOutput(root)).toEqual({});
});
