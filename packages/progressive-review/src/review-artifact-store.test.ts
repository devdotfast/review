import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  REVIEW_ARTIFACTS_DIR,
  ReviewArtifactConflictError,
  ReviewArtifactCorruptError,
  installReviewArtifact,
  readReviewArtifactBytes,
  readReviewDocumentArtifact,
  readReviewSoftwareMapArtifact,
  reviewArtifactHash,
  reviewArtifactPath,
} from "./review-artifact-store";
import { bundleReviewDocument } from "./review-bundle";
import {
  REVIEW_DOCUMENT_FORMAT,
  type ReviewDocumentData,
} from "./review-document-data";
import {
  bundleReviewSoftwareMap,
  softwareMapArtifactBytes,
} from "./software-map-bundle";
import { defineSoftwareMap } from "./software-map-model";

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

describe("reviewArtifactPath and reviewArtifactHash", () => {
  it("places document and map artifacts under distinct directories", () => {
    directory = "/reviews/uuid";
    const hash = "a".repeat(64);
    expect(reviewArtifactPath(directory, "document", hash)).toBe(
      path.join(directory, REVIEW_ARTIFACTS_DIR, "documents", `${hash}.json`),
    );
    expect(reviewArtifactPath(directory, "map", hash)).toBe(
      path.join(directory, REVIEW_ARTIFACTS_DIR, "maps", `${hash}.json`),
    );
  });

  it("hashes bytes as full 64-hex sha256", () => {
    expect(reviewArtifactHash("hello")).toMatch(/^[0-9a-f]{64}$/);
    expect(reviewArtifactHash("hello")).toBe(reviewArtifactHash("hello"));
    expect(reviewArtifactHash("hello")).not.toBe(reviewArtifactHash("world"));
  });
});

describe("installReviewArtifact", () => {
  it("writes new bytes at mode 0o600 and reports reused: false", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-artifact-store-"));
    const installed = await installReviewArtifact(
      directory,
      "document",
      "hello\n",
    );
    expect(installed.reused).toBe(false);
    expect(installed.hash).toBe(reviewArtifactHash("hello\n"));
    expect(installed.path).toBe(
      reviewArtifactPath(directory, "document", installed.hash),
    );
    expect(await readFile(installed.path, "utf8")).toBe("hello\n");
    expect((await stat(installed.path)).mode & 0o777).toBe(0o600);
  });

  it("reuses identical bytes without rewriting the file", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-artifact-store-"));
    const first = await installReviewArtifact(directory, "document", "hello\n");
    const before = await stat(first.path);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await installReviewArtifact(
      directory,
      "document",
      "hello\n",
    );
    expect(second.reused).toBe(true);
    expect(second.hash).toBe(first.hash);
    const after = await stat(first.path);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("throws a conflict error when different bytes hash the same target", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-artifact-store-"));
    const installed = await installReviewArtifact(
      directory,
      "document",
      "hello\n",
    );
    await writeFile(installed.path, "tampered\n", "utf8");
    await expect(
      installReviewArtifact(directory, "document", "hello\n"),
    ).rejects.toBeInstanceOf(ReviewArtifactConflictError);
  });

  it("rejects installing through a symlink", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-artifact-store-"));
    const hash = reviewArtifactHash("hello\n");
    const target = reviewArtifactPath(directory, "document", hash);
    await mkdir(path.dirname(target), { recursive: true });
    const elsewhere = path.join(directory, "elsewhere.json");
    await writeFile(elsewhere, "hello\n", "utf8");
    await symlink(elsewhere, target);
    await expect(
      installReviewArtifact(directory, "document", "hello\n"),
    ).rejects.toThrow("symlink");
  });
});

describe("readReviewArtifactBytes", () => {
  it("returns null when the artifact is missing", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-artifact-store-"));
    await expect(
      readReviewArtifactBytes(directory, "document", "a".repeat(64)),
    ).resolves.toBeNull();
  });

  it("throws a corrupt error when the bytes no longer match the hash", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-artifact-store-"));
    const installed = await installReviewArtifact(
      directory,
      "document",
      "hello\n",
    );
    await writeFile(installed.path, "tampered\n", "utf8");
    await expect(
      readReviewArtifactBytes(directory, "document", installed.hash),
    ).rejects.toBeInstanceOf(ReviewArtifactCorruptError);
  });

  it("returns the exact bytes when they match the hash", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-artifact-store-"));
    const installed = await installReviewArtifact(directory, "map", "hello\n");
    await expect(
      readReviewArtifactBytes(directory, "map", installed.hash),
    ).resolves.toBe("hello\n");
  });
});

describe("readReviewDocumentArtifact", () => {
  it("returns the parsed document bundle for stored bytes", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-artifact-store-"));
    const bundle = bundleReviewDocument(document);
    const installed = await installReviewArtifact(
      directory,
      "document",
      bundle.json,
    );
    await expect(
      readReviewDocumentArtifact(directory, installed.hash),
    ).resolves.toEqual(bundle);
  });

  it("returns null when the artifact is missing", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-artifact-store-"));
    await expect(
      readReviewDocumentArtifact(directory, "a".repeat(64)),
    ).resolves.toBeNull();
  });

  it("returns null for hash-valid bytes that fail document schema validation", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-artifact-store-"));
    const installed = await installReviewArtifact(
      directory,
      "document",
      `${JSON.stringify({ not: "a document" })}\n`,
    );
    await expect(
      readReviewDocumentArtifact(directory, installed.hash),
    ).resolves.toBeNull();
  });
});

describe("readReviewSoftwareMapArtifact", () => {
  it("returns the parsed map bundle for stored envelope bytes", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-artifact-store-"));
    const head = defineSoftwareMap({ systems: { app: { label: "App" } } });
    const base = defineSoftwareMap({ systems: { api: { label: "API" } } });
    const bundle = bundleReviewSoftwareMap({
      head,
      base,
      headCommit: "a".repeat(40),
      baseCommit: "b".repeat(40),
    });
    const bytes = softwareMapArtifactBytes(bundle);
    const installed = await installReviewArtifact(directory, "map", bytes);
    await expect(
      readReviewSoftwareMapArtifact(directory, installed.hash),
    ).resolves.toEqual(bundle);
  });

  it("returns null when the artifact is missing", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-artifact-store-"));
    await expect(
      readReviewSoftwareMapArtifact(directory, "a".repeat(64)),
    ).resolves.toBeNull();
  });
});
