import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts",
    "contracts/index": "src/contracts/index.ts",
    "core/index": "src/core/index.ts",
    "i18n/index": "src/i18n/index.ts",
    "ui/index": "src/ui/index.ts"
  },
  external: ["react", "react-dom", "valtio", "valtio/vanilla"],
  format: ["esm"],
  sourcemap: true
});
