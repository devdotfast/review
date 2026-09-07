import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertNoRuntimeBundler } from "./stage-review-runtime.mjs";

test("runtime closure rejects transitive esbuild packages and native binaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-bundler-closure-"));
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "review" }),
    );
    await assertNoRuntimeBundler(root);
    for (const name of ["esbuild", "@esbuild/darwin-arm64"]) {
      const nested = path.join(
        root,
        "node_modules/.pnpm/dependency/node_modules/hidden",
      );
      await mkdir(nested, { recursive: true });
      await writeFile(
        path.join(nested, "package.json"),
        JSON.stringify({ name }),
      );
      await assert.rejects(assertNoRuntimeBundler(root), /must not ship/);
      await rm(path.join(root, "node_modules"), { recursive: true });
    }
    await writeFile(path.join(root, "esbuild"), "binary");
    await assert.rejects(assertNoRuntimeBundler(root), /must not ship esbuild/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packaged closure inspects ASAR directory headers for bundled esbuild", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-bundler-asar-"));
  const archive = path.join(root, "node_modules.asar");
  try {
    for (const name of ["safe-package", "esbuild", "@esbuild"]) {
      const json = Buffer.from(
        JSON.stringify({ files: { [name]: { files: {} } } }),
      );
      const headerSize = 8 + Math.ceil(json.length / 4) * 4;
      const header = Buffer.alloc(8 + headerSize);
      header.writeUInt32LE(4, 0);
      header.writeUInt32LE(headerSize, 4);
      header.writeUInt32LE(headerSize - 4, 8);
      header.writeUInt32LE(json.length, 12);
      json.copy(header, 16);
      await writeFile(archive, header);
      if (name === "safe-package") await assertNoRuntimeBundler(root);
      else
        await assert.rejects(
          assertNoRuntimeBundler(root),
          /must not ship esbuild/,
        );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
