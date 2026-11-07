import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { toolChangeAdapter } from "./tool-change-adapter";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tests and the e2e harness only. The apps bundle the GUI's sources themselves.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [toolChangeAdapter(), {
    name: "desktop-resource-fixture-verification",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.startsWith("/__test/native-preview")) { response.setHeader("Content-Security-Policy", "frame-ancestors 'none'"); response.end("<!doctype html><title>Isolated native fixture</title><h1>Native preview</h1>"); return; }
        if (!request.url?.startsWith("/__test/resources")) return next();
        response.setHeader("Content-Type", "text/html");
        response.end(`<!doctype html><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; await import('/@fs/${fileURLToPath(new URL("../../e2e/fixtures/conversation-resources.tsx", import.meta.url))}');</script>`);
      });
    },
    resolveId(id) { if (id === "#verification-dev/renderer") return "\0fixture-verification"; return null; },
    load(id) { if (id === "\0fixture-verification") return "export const verificationRenderer = undefined;"; return null; },
  }, react(), tailwindcss()],
  resolve: {
    dedupe: ["react", "react-dom", "@tiptap/core", "@tiptap/pm", "@tiptap/react"],
  },
  // Rendering the GUI takes seconds on a loaded CI runner.
  test: { testTimeout: 20_000 },
});
