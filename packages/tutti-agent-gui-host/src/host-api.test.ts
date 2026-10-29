// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createAgentGuiHostApi } from "./host-api";
import type { AgentGuiRpcClient } from "./protocol";

describe("host toast feedback", () => {
  it.each(["success", "info", "error"] as const)("preserves %s through the host bridge", (tone) => {
    const request = vi.fn().mockResolvedValue(undefined);
    const host = createAgentGuiHostApi({ request } as unknown as AgentGuiRpcClient,
      { workspaceId: "workspace", locale: "zh-CN" },
      { getWorkspaceState: () => ({ agents: [], sessions: [] }), subscribeWorkspace: () => () => {} });
    host.toast![tone]!("Clipboard feedback");
    expect(request).toHaveBeenCalledExactlyOnceWith("host.showMessage", { message: "Clipboard feedback", tone });
  });
});
