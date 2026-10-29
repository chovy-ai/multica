import { runClaudeHost } from "./host";

// One Claude conversation per process, started by the daemon with ELECTRON_RUN_AS_NODE=1.
runClaudeHost({
  input: process.stdin,
  output: process.stdout,
  sdk: () => import("@anthropic-ai/claude-agent-sdk"),
  exit: (code) => { process.exitCode = code; process.stdin.destroy(); setImmediate(() => process.exit(code)); },
  log: (message) => process.stderr.write(`claude-host: ${message}\n`),
});
