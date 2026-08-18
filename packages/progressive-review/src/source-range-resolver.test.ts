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
