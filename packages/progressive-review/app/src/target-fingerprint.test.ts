import { createGitLabTextDiffPosition } from "@dev.fast/review-protocol";
import { describe, expect, it } from "vitest";

import {
  buildAnchorTextTarget,
  buildBlockTarget,
  buildCodeTarget,
  buildGraphTarget,
  buildTableCellTarget,
  codeTargetProjectionSides,
  projectCodeTarget,
  stableHash,
  targetKey,
  targetsEqual,
} from "./target-fingerprint";

describe("target fingerprints", () => {
  it("uses unprefixed FNV hashes", () => {
    expect(stableHash("hello")).toMatch(/^[0-9a-f]{8}$/);
    expect(stableHash("hello")).not.toContain("sha256:");
  });

  it("builds identical creation and check payloads for prose blocks", () => {
    const input = {
      tag: "p",
      index: 2,
      text: "Before   selected text after",
      start: 9,
      length: 13,
    };
    const created = buildBlockTarget(input);
    const checked = buildBlockTarget(input);
    expect(targetsEqual(created, checked)).toBe(true);
    expect(created).toMatchObject({
      surface: { blockHash: expect.stringMatching(/^[0-9a-f]{8}$/) },
      selection: { quote: "selected text" },
    });
  });

  it("preserves whitespace exactly in document block targets", () => {
    const text = "  const first = true;\n    return first;";
    const target = buildBlockTarget({
      tag: "pre",
      index: 2,
      text,
      start: 0,
      length: text.length,
    });

    expect(target).toMatchObject({
      surface: { blockHash: stableHash(text) },
      selection: {
        start: 0,
        length: text.length,
        quote: text,
        hash: stableHash(text),
      },
    });
  });

  it("builds identical creation and check payloads for table cells", () => {
    const input = {
      table: 1,
      row: 2,
      column: 3,
      text: "cell value",
      start: 0,
      length: 4,
    };
    expect(
      targetsEqual(buildTableCellTarget(input), buildTableCellTarget(input)),
    ).toBe(true);
  });

  it("builds independent anchor title and detail targets", () => {
    const input = {
      anchorId: "runtime",
      field: "detail" as const,
      text: "Starts   the server",
    };
    const created = buildAnchorTextTarget(input);
    expect(targetsEqual(created, buildAnchorTextTarget(input))).toBe(true);
    expect(created).toMatchObject({
      surface: { part: { type: "text", field: "detail" } },
      selection: { quote: "Starts   the server" },
    });
    expect(
      targetsEqual(
        created,
        buildAnchorTextTarget({
          anchorId: "runtime",
          field: "title",
          text: "Starts the server",
        }),
      ),
    ).toBe(false);
  });

  it("builds identical creation and check payloads for code", () => {
    const input = {
      path: "src/review.ts",
      side: "head" as const,
      baseCommit: "base-commit",
      headCommit: "head-commit",
      span: { startLine: 3, endLine: 5 },
    };
    expect(targetsEqual(buildCodeTarget(input), buildCodeTarget(input))).toBe(
      true,
    );
  });

  it("preserves canonical base-side code identity", () => {
    const target = buildCodeTarget({
      path: "src/review.ts",
      side: "base",
      baseCommit: "base-commit",
      headCommit: "head-commit",
      span: { startLine: 8, endLine: 9 },
    });

    expect(target.position).toMatchObject({
      base_sha: "base-commit",
      start_sha: "base-commit",
      head_sha: "head-commit",
      old_path: "src/review.ts",
      new_path: "src/review.ts",
      line_range: {
        start: { type: "old", old_line: 8, new_line: null },
        end: { type: "old", old_line: 9, new_line: null },
      },
    });
  });

  it("projects one cross-side position into both diff sides", () => {
    const position = createGitLabTextDiffPosition({
      base_sha: "base-commit",
      start_sha: "base-commit",
      head_sha: "head-commit",
      old_path: "src/review.ts",
      new_path: "src/review.ts",
      start: { old_line: 3, new_line: null },
      end: { old_line: null, new_line: 5 },
    });
    const target = {
      kind: "code" as const,
      original_position: position,
      position,
    };
    const patch = [
      "@@ -3,2 +3,3 @@",
      "-old three",
      "-old four",
      "+new three",
      "+new four",
      "+new five",
    ].join("\n");

    expect(codeTargetProjectionSides(target)).toEqual(["base", "head"]);
    expect(projectCodeTarget(target, "base", patch)).toMatchObject({
      path: "src/review.ts",
      commit: "base-commit",
      span: { startLine: 3, endLine: 4 },
    });
    expect(projectCodeTarget(target, "head", patch)).toMatchObject({
      path: "src/review.ts",
      commit: "head-commit",
      span: { startLine: 3, endLine: 5 },
    });
  });

  it("rejects incomplete code identity", () => {
    expect(() =>
      buildCodeTarget({
        path: "",
        side: "head",
        baseCommit: "base-commit",
        headCommit: "head-commit",
        span: { startLine: 1, endLine: 1 },
      }),
    ).toThrow("path");
    expect(() =>
      buildCodeTarget({
        path: "src/review.ts",
        side: "head",
        baseCommit: "base-commit",
        headCommit: "head-commit",
        span: { startLine: 2, endLine: 1 },
      }),
    ).toThrow("span");
  });

  it("builds identical creation and check payloads for graph elements", () => {
    const input = {
      diagram: "Request flow",
      type: "edge" as const,
      path: ["Browser→Worker"],
      payload: { from: "Browser", label: "Dispatch", to: "Worker" },
      quote: "Dispatch",
    };
    const created = buildGraphTarget(input);
    expect(targetsEqual(created, buildGraphTarget(input))).toBe(true);
    expect(targetKey(created)).toBe(targetKey(buildGraphTarget(input)));
  });

  it("canonicalizes optional undefined graph payload fields", () => {
    const withoutOptional = buildGraphTarget({
      diagram: "Request flow",
      type: "edge",
      path: ["Browser→Worker"],
      payload: { from: "Browser", to: "Worker" },
      quote: "Browser to Worker",
    });
    const withUndefined = buildGraphTarget({
      diagram: "Request flow",
      type: "edge",
      path: ["Browser→Worker"],
      payload: { from: "Browser", label: undefined, to: "Worker" },
      quote: "Browser to Worker",
    });
    expect(withUndefined.element.hash).toBe(withoutOptional.element.hash);
  });
});
