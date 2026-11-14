// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
vi.mock("./local-v2-transport", () => ({ localV2Transport: vi.fn() }));
import {
  AgentMemoryConflictError,
  AgentMemoryRestoreTargetError,
} from "@multica/views/agents";
import { createAgentMemoryAdapter } from "./agent-memory-adapter";

describe("agent memory adapter", () => {
  it("provides safe fallbacks for malformed responses", async () => {
    const request = vi.fn(async () => ({
      exists: true,
      entries: [null],
      trash: null,
      projects: "invalid",
    }));
    const a = createAgentMemoryAdapter(request);
    expect(await a.tree("agent")).toEqual({
      exists: true,
      root: "",
      index: "",
      entries: [],
      projects: [],
      trash: [],
    });
    expect(await a.search("agent", "query")).toEqual([]);
    expect((await a.read("agent", "feedback/test.md")).path).toBe("");
  });
  it("converts snake case at the boundary and preserves the expected version", async () => {
    const wire = {
      path: "feedback/test.md",
      kind: "feedback",
      title: "T",
      description: "D",
      created_at: "created",
      updated_at: "updated",
      source: "CHOV-117",
      body: "B",
      document: "---\ncustom: retained\n---\nB",
    };
    const request = vi.fn(async () => ({ entry: wire, warnings: [] }));
    const a = createAgentMemoryAdapter(request);
    expect(await a.read("agent", wire.path)).toMatchObject({
      updatedAt: "updated",
      createdAt: "created",
      projectDir: "",
      document: wire.document,
    });
    await a.update("agent", {
      path: wire.path,
      document: "---\ntitle: New\n---\nB",
      expectedUpdatedAt: "updated",
    });
    expect(request).toHaveBeenLastCalledWith(
      "PUT",
      "/local/agents/agent/memory/entry",
      expect.objectContaining({
        expected_updated_at: "updated",
        document: "---\ntitle: New\n---\nB",
      }),
    );
  });
  it.each([
    ["conflict", AgentMemoryConflictError],
    ["restore_target_exists", AgentMemoryRestoreTargetError],
  ] as const)("converts %s into a typed error", async (kind, error) => {
    const a = createAgentMemoryAdapter(async () => {
      throw Object.assign(new Error("refused"), { kind });
    });
    await expect(a.restore("agent", "trash/path")).rejects.toBeInstanceOf(
      error,
    );
  });
});
