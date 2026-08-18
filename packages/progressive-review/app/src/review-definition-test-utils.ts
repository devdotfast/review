import {
  type CodePeekProps,
  type CodePeekResolution,
  createReviewDefinitionSession,
} from "../../src/authoring";
import { defineSoftwareModel } from "./software-map/model";

export function testCodePeekResolution(): CodePeekResolution {
  const sourceId = "source-range:src/example.ts:1-1";
  return {
    snapshot: {
      roots: [{ kind: "source", sourceId }],
      resolved: {
        [sourceId]: {
          source: {
            id: sourceId,
            name: "example.ts L1-L1",
            kind: "source-range",
            file: "src/example.ts",
            line: 1,
            endLine: 1,
          },
          lines: [[{ t: "export function example() {}", k: "t" }]],
        },
      },
    },
    diff: {
      orientation: "head",
      files: [
        {
          path: "src/example.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch:
            "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-export function example() {}\n+export function example() { return true; }",
        },
      ],
    },
  };
}

export function createTestReviewDefinitionSession(
  options: {
    softwareMap?: ReturnType<typeof defineSoftwareModel>;
    resolveCodePeek?: (props: CodePeekProps) => Promise<CodePeekResolution>;
  } = {},
) {
  const softwareMap =
    options.softwareMap ?? defineSoftwareModel({ systems: {} });
  return createReviewDefinitionSession({
    softwareMap,
    baseSoftwareMap: softwareMap,
    resolveCodePeek:
      options.resolveCodePeek ?? (async () => testCodePeekResolution()),
  });
}
