// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { localProviderModels } from "./local-provider-models";

describe("local model thinking capabilities", () => {
  it("preserves Codex model-specific levels and ignores hidden and malformed rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "thinking-catalog-"));
    const query = vi.fn(); const findClaude = vi.fn();
    try {
      await writeFile(join(root, "models_cache.json"), JSON.stringify({ models: [
        { slug: "reasoning", default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "low", description: "Quick" }, { effort: "ultra" }, {}, null] },
        { slug: "plain", supported_reasoning_levels: [] }, { slug: "hidden", visibility: "hide" }, null,
      ] }));
      const catalog = await localProviderModels("codex", { codexHome: root, query, findClaude });
      expect(catalog.models.map((model) => model.id)).toEqual(["reasoning", "plain"]);
      expect(catalog.models[0]?.thinking).toEqual({ default_level: "medium", supported_levels: [
        { value: "low", label: "Low", description: "Quick" }, { value: "ultra", label: "Ultra" },
      ] });
      expect(catalog.models[1]?.thinking?.supported_levels).toEqual([]);
      expect(query).not.toHaveBeenCalled();
      expect(findClaude).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("uses the installed Claude catalog without submitting a prompt and closes its transport", async () => {
    const close = vi.fn();
    const supportedModels = vi.fn(async () => [
      { value: "opus", displayName: "Opus", description: "", supportsEffort: true, supportedEffortLevels: ["low", "max"] as ("low" | "max")[] },
      { value: "haiku", displayName: "Haiku", description: "", supportsEffort: false },
    ]);
    let promptCount = 0;
    const query = vi.fn(async (prompt: AsyncIterable<unknown>) => {
      void (async () => { for await (const _ of prompt) promptCount++; })();
      return { supportedModels, close };
    });
    const catalog = await localProviderModels("claude", { codexHome: "/test-owned/missing", query, findClaude: async () => "/test-owned/fake-claude" });
    expect(catalog.models[0]?.thinking?.supported_levels.map((level) => level.value)).toEqual(["low", "max"]);
    expect(catalog.models[1]?.thinking).toBeUndefined();
    expect(promptCount).toBe(0); expect(close).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toBeDefined();
  });
  it("surfaces Claude catalog failures and closes the transport", async () => {
    const close = vi.fn();
    await expect(localProviderModels("claude", { codexHome: "/test-owned/missing", findClaude: async () => "/fake-claude",
      query: async () => ({ close, supportedModels: async () => { throw new Error("unsupported control request"); } }),
    })).rejects.toThrow("unsupported control request");
    expect(close).toHaveBeenCalledOnce();
  });
});
