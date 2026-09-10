import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Published Review bytes live in the artifact store, not in a private Git repo
 * under the Review directory. The remaining Git surface is read-only
 * (`reviewVcs.log`/`resolve`/`materialize`, for importing Git-era Reviews), so
 * no production module may seal a revision, materialize one into `.build/`, or
 * write a `.bundle/` tree again.
 */
const FORBIDDEN_WRITERS = [
  "reviewVcs.init",
  "reviewVcs.seal",
  "sealReviewCandidate",
  "materializePublishRevision",
  "writeReviewDocumentBundle",
  "writeReviewSoftwareMapBundle",
] as const;

/** Test scaffolding and the shipped tutorial build still produce Git-era and
 * bundle trees on purpose; the read-only importer is the one production module
 * allowed to touch a Review's private history. */
const EXEMPT_FILES = new Set(["legacy-review-import.ts"]);

const SOURCE_ROOT = path.join(import.meta.dirname);

describe("production Review writers", () => {
  it("never seals revisions, materializes builds, or writes bundles", async () => {
    const hits: string[] = [];
    for (const file of await productionSourceFiles(SOURCE_ROOT)) {
      const lines = (await readFile(file, "utf8")).split("\n");
      lines.forEach((line, index) => {
        for (const writer of FORBIDDEN_WRITERS) {
          if (!line.includes(writer) || declaresWriter(line, writer)) continue;
          hits.push(
            `${path.relative(SOURCE_ROOT, file)}:${index + 1}: ${line.trim()}`,
          );
        }
      });
    }

    expect(hits).toEqual([]);
  });
});

/** The bundle writers survive as exports for `scripts/build-tutorial-assets.ts`
 * and fixtures, so their own declarations are not production calls. Every other
 * forbidden writer must not exist at all. */
const DECLARABLE_WRITERS = new Set([
  "writeReviewDocumentBundle",
  "writeReviewSoftwareMapBundle",
]);

function declaresWriter(line: string, writer: string): boolean {
  if (!DECLARABLE_WRITERS.has(writer)) return false;
  return new RegExp(`^export (?:async )?function ${writer}\\(`).test(line);
}

async function productionSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "fixtures") continue;
      files.push(...(await productionSourceFiles(entryPath)));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts")) continue;
    if (entry.name.includes("test-utils")) continue;
    if (EXEMPT_FILES.has(entry.name)) continue;
    files.push(entryPath);
  }
  return files;
}
