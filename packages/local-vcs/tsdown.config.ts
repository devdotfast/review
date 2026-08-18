import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  platform: "node",
  target: "node24",
  format: "esm",
  outDir: "dist",
  fixedExtension: false,
  dts: true,
});
