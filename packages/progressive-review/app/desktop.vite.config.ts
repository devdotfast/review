import { createRequire } from "node:module";
import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { scopeReviewCanvasCss } from "./desktop-css-scope";
import {
  hardenLibavoidForTrustedTypes,
  isLibavoidBrowserModule,
} from "./desktop-trusted-types";

const require = createRequire(import.meta.url);
const decodeNamedCharacterReferenceIndex = path.join(
  path.dirname(require.resolve("decode-named-character-reference")),
  "index.js",
);

export default defineConfig({
  root: __dirname,
  plugins: [
    {
      name: "harden-libavoid-trusted-types",
      enforce: "pre",
      transform(source, moduleId) {
        if (!isLibavoidBrowserModule(moduleId)) return;
        return {
          code: hardenLibavoidForTrustedTypes(source),
          map: null,
        };
      },
    },
    react(),
    {
      name: "scope-review-canvas-css",
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type !== "asset" || !output.fileName.endsWith(".css")) {
            continue;
          }
          const source =
            typeof output.source === "string"
              ? output.source
              : new TextDecoder().decode(output.source);
          output.source = scopeReviewCanvasCss(source);
        }
      },
    },
  ],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "decode-named-character-reference": decodeNamedCharacterReferenceIndex,
    },
  },
  build: {
    copyPublicDir: false,
    emptyOutDir: true,
    manifest: true,
    outDir: "dist/desktop",
    rollupOptions: {
      preserveEntrySignatures: "strict",
      input: {
        canvas: path.resolve(__dirname, "src/desktop-entry.tsx"),
        "doc-runtime": path.resolve(__dirname, "src/doc-runtime.ts"),
      },
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
