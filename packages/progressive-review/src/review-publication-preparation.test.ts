import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeIncrementalReviewDocument } from "./incremental-review-document";
import { REVIEW_DOCUMENT_BUNDLE_DIR } from "./review-bundle";
import type { StoredReview } from "./review-home";
import { prepareReviewDocumentBundle } from "./review-publication-preparation";

let reviewDir: string | undefined;

afterEach(async () => {
  if (reviewDir) await rm(reviewDir, { recursive: true, force: true });
  reviewDir = undefined;
});

describe("incremental Review publication", () => {
  it("validates the node envelope without compiling its markdown as MDX", async () => {
    reviewDir = await mkdtemp(
      path.join(tmpdir(), "review-publish-incremental-"),
    );
    await writeFile(
      path.join(reviewDir, "review.mdx"),
      serializeIncrementalReviewDocument(1, [
        {
          id: "untrusted",
          kind: "markdown",
          content: "# Safe\n\n<ComponentThatMustNotExecute />",
        },
      ]),
      "utf8",
    );
    const staleBundle = path.join(reviewDir, REVIEW_DOCUMENT_BUNDLE_DIR);
    await mkdir(staleBundle, { recursive: true });
    await writeFile(path.join(staleBundle, "review-document.js"), "stale");

    await expect(
      prepareReviewDocumentBundle({ review: storedReview(reviewDir) }),
    ).resolves.toEqual({ warnings: [] });
    await expect(access(staleBundle)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function storedReview(dir: string): StoredReview {
  return {
    dir,
    review: {
      uuid: "86df96ed-65ef-46de-9348-c94811e3bb46",
    },
  } as StoredReview;
}
