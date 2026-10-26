import { resolve } from "path";
import { execFileSync } from "node:child_process";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  main: {
    // Workspace packages expose raw TypeScript; main must bundle their runtime imports.
    plugins: [externalizeDepsPlugin({ exclude: ["@multica/tutti-agent-gui-host", "@multica/core"] })],
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
