import path from "node:path";

import { describe, expect, it } from "vitest";

import { unsupportedTypescriptDiagnostics } from "./review-document-syntax-validator";
import type { AuthoredTypescriptRegion } from "./review-document-syntax-validator";

const filePath = path.join(process.cwd(), "reviews", "typed.mdx");

function authoredRegion(value: string): AuthoredTypescriptRegion {
  return {
    kind: "esm",
    sourceStartColumn: 1,
    sourceStartLine: 1,
    value,
  };
}

describe("unsupportedTypescriptDiagnostics", () => {
  it.each([
    [
      "enum declarations",
      'export enum Theme { Light = "light", Dark = "dark" }',
      "enum declarations",
    ],
    [
      "namespace declarations",
      'export namespace Theme { export const dark = "dark"; }',
      "namespace declarations",
    ],
    ["decorators", "@sealed\nexport class Review {}", "decorators"],
    [
      "parameter properties",
      "export class Actor { constructor(public label: string) {} }",
      "parameter properties",
    ],
  ])("rejects %s", (_label, source, message) => {
    expect(
      unsupportedTypescriptDiagnostics({ filePath }, [authoredRegion(source)]),
    ).toEqual([
      expect.objectContaining({
        code: "UNSUPPORTED_TYPESCRIPT_SYNTAX",
        message: expect.stringContaining(message),
        severity: "error",
        source: "typescript",
      }),
    ]);
  });
});
