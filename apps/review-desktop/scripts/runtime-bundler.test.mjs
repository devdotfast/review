import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertNoRuntimeBundler,
  assertPackagedArtifacts,
  assertRuntimeClosure,
  assertRuntimeContents,
  requiredPackagedArtifacts,
  runtimeRootForPackagedRoot,
} from "./stage-review-runtime.mjs";

test("runtime closure rejects transitive esbuild packages and native binaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-bundler-closure-"));
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "review" }),
    );
    await assertRuntimeContents(root);
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
      await assert.rejects(assertRuntimeContents(root), /must not ship/);
      await rm(path.join(root, "node_modules"), { recursive: true });
    }
    await writeFile(path.join(root, "esbuild"), "binary");
    await assert.rejects(assertRuntimeContents(root), /must not ship esbuild/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packaged closure inspects ASAR directory headers for bundled esbuild", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-bundler-asar-"));
  const archive = path.join(root, "node_modules.asar");
  try {
    for (const name of ["safe-package", "esbuild", "@esbuild"]) {
      await writeFile(archive, asarHeader(name));
      for (const inspect of [assertNoRuntimeBundler, assertRuntimeContents]) {
        if (name === "safe-package") await inspect(root);
        else await assert.rejects(inspect(root), /must not ship esbuild/);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime inspection rejects checkout paths and escaping links while accepting internal links", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-relocatable-"));
  const checkout = path.resolve(import.meta.dirname, "../../..");
  try {
    await mkdir(path.join(root, "dist"));
    await writeFile(path.join(root, "dist/entry.js"), "export {};\n");
    await symlink("dist/entry.js", path.join(root, "internal-link"));
    await symlink(".", path.join(root, "root-link"));
    await assertRuntimeContents(root);
    for (const relative of [
      "package.json",
      "dist/entry.js",
      "dist/entry.cjs",
      "dist/entry.js.map",
      "dist/authoring.d.ts",
    ]) {
      const file = path.join(root, relative);
      await writeFile(file, JSON.stringify({ checkout }));
      await assert.rejects(assertRuntimeContents(root), (error) =>
        error.message.includes(`${relative} (build checkout path)`),
      );
      await writeFile(file, "{}\n");
    }
    await symlink("missing", path.join(root, "broken-link"));
    await assert.rejects(
      assertRuntimeContents(root),
      /broken-link.*broken link/,
    );
    await rm(path.join(root, "broken-link"));
    await symlink(checkout, path.join(root, "external-link"));
    await assert.rejects(
      assertRuntimeContents(root),
      /external-link.*escapes runtime/,
    );
    await rm(path.join(root, "external-link"));
    await assertRuntimeContents(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("final package verification requires authoring declarations and rechecks archives outside the runtime", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "review-package-inspection-"),
  );
  const packaged = path.join(root, "Review.app");
  const runtime = runtimeRootForPackagedRoot(packaged);
  const declarations = path.join(runtime, "dist/authoring.d.ts");
  try {
    for (const artifact of requiredPackagedArtifacts(packaged)) {
      if (artifact === declarations) continue;
      await mkdir(path.dirname(artifact), { recursive: true });
      if (artifact === path.join(runtime, "app/src")) {
        await mkdir(artifact);
      } else if (artifact !== path.join(runtime, "node_modules")) {
        await writeFile(artifact, artifact.endsWith(".json") ? "{}\n" : "");
      }
    }
    await writeFile(
      path.join(runtime, "tutorial/runtime-manifest.json"),
      JSON.stringify({
        version: 1,
        reviewFiles: ["review.mdx"],
        requiredPaths: ["review.mdx"],
      }),
    );
    await writeFile(path.join(runtime, "tutorial/review.mdx"), "# Tutorial\n");
    await assert.rejects(
      assertRuntimeClosure(runtime),
      /missing dist\/authoring\.d\.ts/,
    );
    await assert.rejects(
      assertPackagedArtifacts(packaged),
      /missing .*authoring\.d\.ts/,
    );
    await writeFile(declarations, "export {};\n");
    await assertRuntimeClosure(runtime);
    await assertPackagedArtifacts(packaged);

    const archive = path.join(
      packaged,
      "Contents/Resources/app/extensions/dependency.asar",
    );
    await mkdir(path.dirname(archive), { recursive: true });
    await writeFile(archive, asarHeader("safe-package"));
    await assertPackagedArtifacts(packaged);
    await writeFile(archive, asarHeader("@esbuild"));
    // The staged runtime is unchanged; the final app inspection must still
    // detect content introduced by a later packaging step.
    await assertRuntimeClosure(runtime);
    await assert.rejects(
      assertPackagedArtifacts(packaged),
      /must not ship esbuild/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function asarHeader(name) {
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
  return header;
}
