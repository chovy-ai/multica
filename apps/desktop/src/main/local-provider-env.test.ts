// @vitest-environment node
import { describe, expect, it } from "vitest";
import { localProviderEnv } from "./local-provider-env";

describe("local provider environment", () => {
  it("forwards discovery and proxy settings but never credentials or Electron flags", () => {
    expect(localProviderEnv({ PATH: "/bin", HOME: "/h", CODEX_HOME: "/c", HTTPS_PROXY: "http://p", no_proxy: "local", OPENAI_API_KEY: "secret", MULTICA_TOKEN: "t", ELECTRON_RUN_AS_NODE: "1" }))
      .toEqual({ PATH: "/bin", HOME: "/h", CODEX_HOME: "/c", HTTPS_PROXY: "http://p", no_proxy: "local" });
  });
});
