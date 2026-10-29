import { resolve } from "path";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Custom chunking replaces the externals electron-vite would otherwise add, so list them here:
// Electron, Node built-ins and runtime dependencies, except workspace packages that ship raw TypeScript.
const bundledDeps = new Set(["@multica/tutti-agent-gui-host", "@multica/core", "@tutti-os/browser-node"]);
const runtimeDeps = Object.keys(JSON.parse(readFileSync(resolve("package.json"), "utf8")).dependencies ?? {}).filter((dep) => !bundledDeps.has(dep));
const mainExternal = (id: string) => id === "electron" || id.startsWith("electron/") || id.startsWith("node:") || builtinModules.includes(id)
  || runtimeDeps.some((dep) => id === dep || id.startsWith(`${dep}/`));

export default defineConfig({
  main: {
    // Workspace packages expose raw TypeScript; main must bundle their runtime imports.
    build: {
      externalizeDeps: false,
      lib: {
        entry: {
          index: resolve("src/main/index.ts"),
          // Standalone stdio MCP that Codex runs with ELECTRON_RUN_AS_NODE=1.
          "developer-logs-mcp": resolve("src/main/developer-logs-mcp.ts"),
          // Local conversation host the daemon runs with ELECTRON_RUN_AS_NODE=1.
          "local-conversation-host": resolve("src/local-host/entry.ts"),
          // One-conversation Claude Agent SDK adapter the daemon runs with ELECTRON_RUN_AS_NODE=1.
          "claude-host": resolve("src/claude-host/entry.ts"),
        },
      },
      rolldownOptions: {
        external: mainExternal,
        output: {
          // Keep everything both entries share out of index.js: the standalone
          // MCP must never load (and so boot) the desktop app.
          // The conversation host shares code with index.js; keep it in its own chunk so the
          // sidecar never loads (and so boots) the desktop app either.
          advancedChunks: { groups: [
            { name: "developer-logs", test: /src\/main\/(developer-log-export|developer-runtime-logs|developer-logs-mcp-server|local-timing-log)\.ts$|tutti-agent-gui-host\/src\/local-timing\.ts$/ },
            // The entry itself stays out: grouping it would merge this chunk into the entry chunk.
            { name: "local-host", test: (id: string) => /src\/(local-host|shared)\/|packages\/core\//.test(id) && !/src\/local-host\/entry\.ts$/.test(id) },
            { name: "claude-host", test: (id: string) => /src\/claude-host\//.test(id) && !/src\/claude-host\/entry\.ts$/.test(id) },
          ] },
        },
      },
    },
  },
  preload: {
    // `@electron-toolkit/preload` must be bundled INTO the preload script:
    // the renderer windows run with `sandbox: true`, and a sandboxed preload's
    // `require` can only load `electron` plus a couple of node builtins — an
    // externalized `require("@electron-toolkit/preload")` would throw and
    // every contextBridge API would vanish. electron-vite emits preload as a
    // single CJS bundle, which is exactly what the sandbox requires.
    plugins: [externalizeDepsPlugin({ exclude: ["@electron-toolkit/preload"] })],
  },
  renderer: {
    server: {
      // Allow parallel worktrees to run `pnpm dev:desktop` side-by-side
      // (e.g. Multica Canary alongside a primary checkout) by overriding
      // the renderer port via env. Falls back to 5173 for the common case.
      port: Number(process.env.DESKTOP_RENDERER_PORT) || 5173,
      strictPort: true,
    },
    plugins: [
      {
        name: "multica-tutti-agent-gui-assets",
        config() {
          execFileSync(process.execPath, [
            resolve("../../packages/tutti-agent-gui-host/scripts/build.mjs"),
          ], { stdio: "inherit" });
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: {
        "@": resolve("src/renderer/src"),
      },
      dedupe: ["react", "react-dom", "@tanstack/react-query"],
    },
  },
});
