import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveReviewSourceRange,
  validateReviewSourceRange,
} from "./source-range-resolver";

describe("source range resolver", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads and tokenizes an exact range", async () => {
    const root = createFixture();
    const snapshot = await resolveReviewSourceRange({
      rootPath: root,
      root: { kind: "range", file: "src/example.ts", fromLine: 2, toLine: 3 },
    });
    const source = snapshot.resolved[snapshot.roots[0]!.sourceId];

    expect(source?.source).toMatchObject({
      file: "src/example.ts",
      line: 2,
      endLine: 3,
    });
    expect(
      source?.lines.map((line) => line.map((token) => token.t).join("")),
    ).toEqual(["export const answer = 42;", "answer += 1;"]);
  });

  it("rejects paths outside the pinned root and lines outside the file", () => {
    const root = createFixture();

    expect(() =>
      validateReviewSourceRange({
        rootPath: root,
        root: { kind: "range", file: "../secret", fromLine: 1, toLine: 1 },
      }),
    ).toThrow("inside the review root");
    expect(() =>
      validateReviewSourceRange({
        rootPath: root,
        root: { kind: "range", file: "src/example.ts", fromLine: 2, toLine: 8 },
      }),
    ).toThrow("exceeds");
  });

  it("rejects an in-root symlink whose absolute target escapes the review root", () => {
    const root = createFixture();
    const outside = createOutsideDir();
    const secretPath = path.join(outside, "secret.txt");
    fs.writeFileSync(secretPath, "REVIEWER-HOST-SECRET");
    // The link path `src/escape.link` is lexically inside the root (no "../"),
    // so a purely lexical containment check passes; its resolved on-disk target
    // is outside the root and must be rejected.
    fs.symlinkSync(secretPath, path.join(root, "src", "escape.link"));

    expect(() =>
      validateReviewSourceRange({
        rootPath: root,
        root: {
          kind: "range",
          file: "src/escape.link",
          fromLine: 1,
          toLine: 1,
        },
      }),
    ).toThrow("inside the review root");
  });

  it("rejects an in-root symlink whose relative target escapes the review root", () => {
    const root = createFixture();
    const outside = createOutsideDir();
    fs.writeFileSync(path.join(outside, "secret.txt"), "ESCAPED");
    // A relative symlink target whose resolved path leaves the root. From
    // `root/src/`, `../../<outsideName>/secret.txt` resolves into the sibling
    // outside dir created in the same tmp parent.
    fs.symlinkSync(
      `../../${path.basename(outside)}/secret.txt`,
      path.join(root, "src", "escape.link"),
    );

    expect(() =>
      validateReviewSourceRange({
        rootPath: root,
        root: {
          kind: "range",
          file: "src/escape.link",
          fromLine: 1,
          toLine: 1,
        },
      }),
    ).toThrow("inside the review root");
  });

  it("still reads a legitimate in-root symlink and reports its link path", async () => {
    const root = createFixture();
    fs.writeFileSync(path.join(root, "real.txt"), "in-root-target");
    fs.symlinkSync("real.txt", path.join(root, "link.txt"));

    const snapshot = await resolveReviewSourceRange({
      rootPath: root,
      root: { kind: "range", file: "link.txt", fromLine: 1, toLine: 1 },
    });
    const source = snapshot.resolved[snapshot.roots[0]!.sourceId];

    expect(source?.source.file).toBe("link.txt");
    expect(
      source?.lines.map((line) => line.map((token) => token.t).join("")),
    ).toEqual(["in-root-target"]);
  });

  it("reads a legitimate file when the review root itself is a symlink", async () => {
    const root = createFixture();
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-rootlink-"));
    roots.push(linkDir);
    const rootLink = path.join(linkDir, "link");
    fs.symlinkSync(root, rootLink);

    const snapshot = await resolveReviewSourceRange({
      rootPath: rootLink,
      root: { kind: "range", file: "src/example.ts", fromLine: 2, toLine: 3 },
    });
    const source = snapshot.resolved[snapshot.roots[0]!.sourceId];

    expect(source?.source.file).toBe("src/example.ts");
    expect(
      source?.lines.map((line) => line.map((token) => token.t).join("")),
    ).toEqual(["export const answer = 42;", "answer += 1;"]);
  });

  function createOutsideDir(): string {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "review-outside-"));
    roots.push(outside);
    return outside;
  }

  function createFixture(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-source-range-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(
      path.join(root, "src", "example.ts"),
      ["// header", "export const answer = 42;", "answer += 1;"].join("\n"),
    );
    return root;
  }
});
