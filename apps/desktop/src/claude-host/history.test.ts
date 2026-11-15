// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import { enrichHistory } from "./history";

it("joins raw metadata only to the SDK-selected branch and retains SDK ordering", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-history-"));
  const id = "11111111-2222-3333-4444-555555555555";
  const folder = join(root, "projects", "project");
  await mkdir(folder, { recursive: true });
  try {
    const path = join(folder, `${id}.jsonl`);
    const metadata = { stdout: "ok", bashEditDiff: { files: [], changedFiles: ["notes.md"], moreFiles: 1 } };
    await writeFile(path, [
      { uuid: "hidden", type: "assistant", message: { content: "not selected" } },
      { uuid: "r1", timestamp: "2026-11-14T08:00:00Z", toolUseResult: metadata },
    ].map((entry) => JSON.stringify(entry)).join("\n"));
    const messages = ["u1", "r1"].map((uuid) => ({ uuid, session_id: id, type: "user", message: { content: [] }, parent_tool_use_id: null, parent_agent_id: null } satisfies SessionMessage));
    const enriched = await enrichHistory(id, messages, root);
    expect(enriched.map((entry) => entry.uuid)).toEqual(["u1", "r1"]);
    expect(enriched[1]).toMatchObject({ timestamp: "2026-11-14T08:00:00Z", tool_use_result: metadata });
    expect(messages[1]).not.toHaveProperty("tool_use_result");
    expect(await enrichHistory("../escape", messages, root)).toEqual(messages);
    await truncate(path, (64 << 20) + 1);
    await expect(enrichHistory(id, messages, root)).rejects.toThrow("size limit");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("keeps SDK history when its local JSONL is unavailable", async () => {
  expect(await enrichHistory("11111111-2222-3333-4444-555555555555", [], "/fixture/missing")).toEqual([]);
});
