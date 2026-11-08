import { fileURLToPath } from "node:url";
import { mergeConfig } from "vite";
import base from "../../packages/tutti-agent-gui-host/vite.config";

// Stable names avoid Rolldown's Unicode hash-placeholder path in this fixture.
// Worker entry names stay separate so the GUI and diff workers cannot collide.
const names = {
  entryFileNames: "assets/[name].js",
  chunkFileNames: "assets/[name].js",
  assetFileNames: "assets/[name][extname]",
};

export default mergeConfig(base, {
  root: fileURLToPath(new URL("../..", import.meta.url)),
  plugins: [{
    name: "resource-performance-empty-bridge",
    resolveId(id: string) { if (id === "#verification-dev/renderer") return "\0resource-perf-empty"; },
    load(id: string) { if (id === "\0resource-perf-empty") return "export const verificationRenderer=undefined;"; },
  }],
  worker: { rollupOptions: { output: {
    ...names,
    entryFileNames: (chunk: { facadeModuleId: string | null; name: string }) =>
      `assets/${chunk.facadeModuleId?.includes("@pierre") ? "diff" : "gui"}-${chunk.name}.js`,
  } } },
  build: {
    outDir: process.env.RESOURCE_PERF_OUT_DIR ?? fileURLToPath(new URL("../../.tmp/resource-perf-dist", import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL("./conversation-resources.html", import.meta.url)),
      output: names,
    },
  },
});

