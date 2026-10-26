// @vitest-environment node
import { describe, expect, it } from "vitest";

import { withClaudeLoginEnv } from "./claude-login-env.mjs";

describe("explicit local Claude login launch", () => {
  it("does not carry the launching agent's provider credentials or model routing into the desktop", () => {
    const inherited = {
      ANTHROPIC_BASE_URL: "https://provider.example.test/anthropic",
      ANTHROPIC_AUTH_TOKEN: "test-provider-token",
      ANTHROPIC_API_KEY: "test-api-key",
      ANTHROPIC_MODEL: "test-provider-model",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "test-provider-model",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "test-provider-model",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "test-provider-model",
      CLAUDE_CODE_OAUTH_TOKEN: "test-override-token",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      HOME: "/home/test-user",
      PATH: "/test/bin",
    };

    expect(withClaudeLoginEnv(inherited)).toEqual({
      HOME: "/home/test-user",
      PATH: "/test/bin",
    });
    expect(inherited.ANTHROPIC_AUTH_TOKEN).toBe("test-provider-token");
  });

  it("preserves the user's CLI config location, other providers, and Multica connection", () => {
    const inherited = {
      HOME: "/home/test-user",
      CLAUDE_CONFIG_DIR: "/home/test-user/claude-profile",
      CODEX_HOME: "/home/test-user/codex-profile",
      OPENAI_API_KEY: "test-unrelated-key",
      VITE_API_URL: "https://api.example.test",
      HTTPS_PROXY: "http://localhost:1234",
    };

    expect(withClaudeLoginEnv(inherited)).toEqual(inherited);
    expect(withClaudeLoginEnv(inherited)).not.toBe(inherited);
  });
});
