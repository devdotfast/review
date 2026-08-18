import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { bundleReviewDocument } from "./server/doc-bundler";

const execFilePromise = promisify(execFile);

export async function runReviewInternalTest(reviewDir: string): Promise<void> {
  const files = await readdir(reviewDir, { withFileTypes: true });
  const typescript = files
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name);
  if (typescript.length > 0) {
    await execFilePromise("tsc", ["--noEmit", ...typescript], {
      cwd: reviewDir,
      maxBuffer: 8 * 1024 * 1024,
    });
  }
  await bundleReviewDocument({
    reviewPath: path.join(reviewDir, "review.mdx"),
    reviewDocumentsDir: reviewDir,
    reviewRootPath: reviewDir,
    routePath: "/",
  });
}
