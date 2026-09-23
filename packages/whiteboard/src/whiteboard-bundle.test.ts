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
  WHITEBOARD_BUNDLE_DIR,
  WHITEBOARD_DOCUMENT_BUNDLE_DIR,
  bundleWhiteboardDocument,
  readWhiteboardDocumentBundle,
  whiteboardDocumentBundleData,
  writeWhiteboardDocumentBundle,
} from "./whiteboard-bundle";
import {
  WHITEBOARD_DOCUMENT_FORMAT,
  type WhiteboardDocumentData,
} from "./whiteboard-document-data";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

const document: WhiteboardDocumentData = {
  format: WHITEBOARD_DOCUMENT_FORMAT,
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
  it("exposes the parsed document through the bundle accessor", async () => {
    const bundle = bundleWhiteboardDocument(document);
    expect(whiteboardDocumentBundleData(bundle)).toEqual(document);
    expect(Object.keys(bundle).sort()).toEqual(["contentHash", "json"]);
  });

  it("upgrades an old sealed bundle on read without rewriting the file", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-document-bundle-"));
    const bundleDir = path.join(directory, WHITEBOARD_DOCUMENT_BUNDLE_DIR);
    await mkdir(bundleDir, { recursive: true });

    const stored = `${JSON.stringify({
      ...document,
      anchors: {
        a: {
          __kind: "db-anchor-ref",
          id: "a",
          title: "A",
          peek: {
            __kind: "code-peek-ref",
            props: { file: "src/a.ts", fromLine: 1, toLine: 2 },
            resolution: null,
          },
        },
      },
    })}\n`;

    await writeFile(
      path.join(bundleDir, "review-document.json"),
      stored,
      "utf8",
    );
    await writeFile(
      path.join(bundleDir, "manifest.json"),
      JSON.stringify({ version: 2, routePath: "/", sourcePath: "review.mdx" }),
      "utf8",
    );

    const bundle = await readWhiteboardDocumentBundle(directory, "/");

    expect(bundle).not.toBeNull();
    expect(whiteboardDocumentBundleData(bundle!).anchors.a?.peek).toEqual({
      file: "src/a.ts",
      start: { side: "head", line: 1 },
      end: { side: "head", line: 2 },
    });
    expect(
      await readFile(path.join(bundleDir, "review-document.json"), "utf8"),
    ).toBe(stored);
  });

  it("writes the document as JSON and reads it back", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-document-bundle-"));
    const bundleDir = path.join(directory, WHITEBOARD_DOCUMENT_BUNDLE_DIR);
    const legacyBundleDir = path.join(directory, WHITEBOARD_BUNDLE_DIR);
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
    const bundle = bundleWhiteboardDocument(document);

    await writeWhiteboardDocumentBundle(directory, bundle);

    expect(await readWhiteboardDocumentBundle(directory, "/")).toEqual(bundle);
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
    await expect(
      readWhiteboardDocumentBundle(directory, "/"),
    ).resolves.toBeNull();

    const bundleDir = path.join(directory, WHITEBOARD_DOCUMENT_BUNDLE_DIR);
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
    await expect(
      readWhiteboardDocumentBundle(directory, "/"),
    ).resolves.toBeNull();

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
    await expect(
      readWhiteboardDocumentBundle(directory, "/"),
    ).resolves.toBeNull();

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
      JSON.stringify({ ...document, format: "whiteboard-document/0" }),
      "utf8",
    );
    await expect(
      readWhiteboardDocumentBundle(directory, "/"),
    ).resolves.toBeNull();
  });
});
