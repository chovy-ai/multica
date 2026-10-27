// Standalone stdio entry, launched by Codex with ELECTRON_RUN_AS_NODE=1.
// It must not import electron or anything that does.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDeveloperLogsMcpServer } from "./developer-logs-mcp-server";

const flag = process.argv.indexOf("--diagnostics");
const diagnosticsDir = flag >= 0 ? process.argv[flag + 1] : undefined;
if (!diagnosticsDir) {
  process.stderr.write("usage: developer-logs-mcp --diagnostics <dir>\n");
  process.exit(2);
}
void createDeveloperLogsMcpServer(diagnosticsDir).connect(new StdioServerTransport()).catch((error: unknown) => {
  process.stderr.write(`multica developer logs MCP failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
