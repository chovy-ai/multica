// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { registerCodexStdioMcp, type StdioMcpServer } from "./codex-mcp-registration";

const server: StdioMcpServer = { name: "multica_developer_logs", command: "/Apps/Multica", args: ["/Apps/out/main/developer-logs-mcp.js", "--diagnostics", "/data/diag"], env: { ELECTRON_RUN_AS_NODE: "1" } };
const registered = (overrides: Record<string, unknown> = {}) => JSON.stringify({ name: server.name, enabled: true, transport: { type: "stdio", command: server.command, args: server.args, env: server.env }, ...overrides });

describe("registerCodexStdioMcp", () => {
  it("adds the server through Codex when it is missing", async () => {
    const exec = vi.fn(async (_file: string, args: string[]) => {
      if (args[1] === "get") throw new Error("No MCP server named");
      return { stdout: "" };
    });
    expect(await registerCodexStdioMcp("/bin/codex", server, exec)).toBe("registered");
    expect(exec).toHaveBeenLastCalledWith("/bin/codex", ["mcp", "add", "multica_developer_logs", "--env", "ELECTRON_RUN_AS_NODE=1", "--", "/Apps/Multica", "/Apps/out/main/developer-logs-mcp.js", "--diagnostics", "/data/diag"]);
  });

  it("leaves an identical registration untouched", async () => {
    const exec = vi.fn(async () => ({ stdout: registered() }));
    expect(await registerCodexStdioMcp("/bin/codex", server, exec)).toBe("unchanged");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("updates a registration that points at an old app location", async () => {
    const exec = vi.fn(async (_file: string, args: string[]) => ({ stdout: args[1] === "get" ? registered({ transport: { type: "stdio", command: "/Old/Multica", args: server.args, env: server.env } }) : "" }));
    expect(await registerCodexStdioMcp("/bin/codex", server, exec)).toBe("registered");
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("respects a server the user disabled", async () => {
    const exec = vi.fn(async () => ({ stdout: registered({ enabled: false, transport: { type: "stdio", command: "/Old/Multica" } }) }));
    expect(await registerCodexStdioMcp("/bin/codex", server, exec)).toBe("disabled-by-user");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("does nothing without Codex", async () => {
    const exec = vi.fn();
    expect(await registerCodexStdioMcp(null, server, exec)).toBe("codex-missing");
    expect(exec).not.toHaveBeenCalled();
  });
});
