import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { stageReviewDocs } from "./stage-review-runtime.mjs";

const temporaryRoots = [];
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

after(async () => {
  await Promise.all(
    temporaryRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

test("stages the complete Review documentation tree inside dev-review", async () => {
  const root = await temporaryRoot("review-runtime-docs-");
  const runtimeRoot = path.join(root, "review-runtime");
  const skillRoot = path.join(runtimeRoot, "skills", "dev-review");
  const docsRoot = path.join(root, "source-docs");
  await mkdir(path.join(skillRoot, "docs"), { recursive: true });
  await mkdir(path.join(docsRoot, "assets"), { recursive: true });
  await writeFile(path.join(skillRoot, "SKILL.md"), "# dev-review\n");
  await writeFile(path.join(skillRoot, "docs", "stale.md"), "stale\n");
  await writeFile(path.join(docsRoot, "README.md"), "# Review docs\n");
  await writeFile(path.join(docsRoot, "guide.md"), "# Guide\n");
  await writeFile(
    path.join(docsRoot, "assets", "image.png"),
    Buffer.from([0, 1, 2, 3]),
  );

  const destination = await stageReviewDocs(runtimeRoot, docsRoot);

  assert.equal(
    await readFile(path.join(destination, "README.md"), "utf8"),
    "# Review docs\n",
  );
  assert.equal(
    await readFile(path.join(destination, "guide.md"), "utf8"),
    "# Guide\n",
  );
  assert.deepEqual(
    await readFile(path.join(destination, "assets", "image.png")),
    Buffer.from([0, 1, 2, 3]),
  );
  await assert.rejects(readFile(path.join(destination, "stale.md")), /ENOENT/);
});

test("bundled Review documentation has no escaping or broken relative links", async () => {
  const docsRoot = path.join(repositoryRoot, "docs");
  const markdownFiles = await listMarkdownFiles(docsRoot);
  const missing = [];

  for (const file of markdownFiles) {
    const source = await readFile(file, "utf8");
    const links = source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g);
    for (const match of links) {
      const target = match[1].trim();
      if (target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) {
        continue;
      }

      const relativeTarget = target.split("#", 1)[0];
      const resolved = path.resolve(path.dirname(file), relativeTarget);
      if (
        resolved !== docsRoot &&
        !resolved.startsWith(`${docsRoot}${path.sep}`)
      ) {
        missing.push(`${path.relative(docsRoot, file)} -> ${target} (escapes)`);
        continue;
      }
      try {
        await access(resolved);
      } catch {
        missing.push(`${path.relative(docsRoot, file)} -> ${target}`);
      }
    }
  }

  assert.deepEqual(missing, []);
});

async function listMarkdownFiles(root) {
  const files = [];
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && entry.name.endsWith(".md"))
        files.push(absolute);
    }
  };
  await walk(root);
  return files;
}
