import crypto from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  REVIEW_BUNDLE_DIR,
  REVIEW_DOCUMENT_BUNDLE_DIR,
  bundleReviewDocument,
  readReviewDocumentBundle,
  writeReviewDocumentBundle,
} from "./review-bundle";
import {
  REVIEW_DOCUMENT_FORMAT,
  type ReviewDocumentData,
} from "./review-document-data";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

const document: ReviewDocumentData = {
  format: REVIEW_DOCUMENT_FORMAT,
  title: "A review",
  routePath: "/",
  sourcePath: "review.mdx",
  body: [
    {
      type: "element",
      tag: "h1",
      props: {},
      children: [{ type: "text", value: "A review" }],
    },
  ],
  anchors: {},
  anchorContents: {},
  softwareModels: [],
};

describe("review document bundle", () => {
  it("writes the document as JSON and reads it back", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-document-bundle-"));
    const bundleDir = path.join(directory, REVIEW_DOCUMENT_BUNDLE_DIR);
    const legacyBundleDir = path.join(directory, REVIEW_BUNDLE_DIR);
    await mkdir(bundleDir, { recursive: true });
    await writeFile(
      path.join(bundleDir, "review-document.js"),
      "export default {};",
      "utf8",
    );
    await writeFile(
      path.join(legacyBundleDir, "review-document.js"),
      "export default {};",
      "utf8",
    );
    await writeFile(
      path.join(legacyBundleDir, "manifest.json"),
      JSON.stringify({ version: 1 }),
      "utf8",
    );
    const bundle = bundleReviewDocument(document);

    await writeReviewDocumentBundle(directory, bundle);

    expect(await readReviewDocumentBundle(directory, "/")).toEqual(bundle);
    expect(bundle.json).toBe(`${JSON.stringify(document)}\n`);
    expect(bundle.contentHash).toBe(
      crypto
        .createHash("sha256")
        .update(bundle.json)
        .digest("hex")
        .slice(0, 20),
    );
    expect((await readdir(bundleDir)).sort()).toEqual([
      "manifest.json",
      "review-document.json",
    ]);
    await expect(
      readFile(path.join(legacyBundleDir, "review-document.js"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(path.join(legacyBundleDir, "manifest.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns null for an absent, incompatible, or invalid bundle", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-document-bundle-"));
    await expect(readReviewDocumentBundle(directory, "/")).resolves.toBeNull();

    const bundleDir = path.join(directory, REVIEW_DOCUMENT_BUNDLE_DIR);
    await mkdir(bundleDir, { recursive: true });
    await writeFile(
      path.join(bundleDir, "manifest.json"),
      JSON.stringify({
        version: 1,
        routePath: "/",
        sourcePath: "review.mdx",
      }),
      "utf8",
    );
    await writeFile(
      path.join(bundleDir, "review-document.js"),
      "export default {};",
      "utf8",
    );
    await expect(readReviewDocumentBundle(directory, "/")).resolves.toBeNull();

    await writeFile(
      path.join(bundleDir, "manifest.json"),
      JSON.stringify({
        version: 2,
        routePath: "/other",
        sourcePath: "review.mdx",
      }),
      "utf8",
    );
    await writeFile(
      path.join(bundleDir, "review-document.json"),
      `${JSON.stringify(document)}\n`,
      "utf8",
    );
    await expect(readReviewDocumentBundle(directory, "/")).resolves.toBeNull();

    await writeFile(
      path.join(bundleDir, "manifest.json"),
      JSON.stringify({
        version: 2,
        routePath: "/",
        sourcePath: "review.mdx",
      }),
      "utf8",
    );
    await writeFile(
      path.join(bundleDir, "review-document.json"),
      JSON.stringify({ ...document, format: "review-document/0" }),
      "utf8",
    );
    await expect(readReviewDocumentBundle(directory, "/")).resolves.toBeNull();
  });
});
