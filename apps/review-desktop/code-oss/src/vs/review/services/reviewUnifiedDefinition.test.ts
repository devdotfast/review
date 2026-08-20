/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { CancellationToken } from "../../base/common/cancellation.js";
import { URI } from "../../base/common/uri.js";
import { Position } from "../../editor/common/core/position.js";
import { Range } from "../../editor/common/core/range.js";
import {
  reviewBaseFileUri,
  reviewHeadFileUri,
} from "../common/reviewCodeResources.js";

test("unified definitions delegate base and head rows to their pinned models", async () => {
  Object.assign(globalThis, {
    window: globalThis,
    location: { href: "http://localhost/" },
  });
  const { provideReviewUnifiedDefinition } = await import(
    "./reviewUnifiedDefinition.js"
  );
  const session = {
    session: {
      rootPath: "/tmp/review-worktree",
      baseRootPath: "/tmp/review-base",
      headRootPath: "/tmp/review-head",
    },
  };
  const unifiedResource = URI.from({
    scheme: "devfast-review-unified",
    path: "/src/example.ts",
  });

  for (const sample of [
    { side: "base" as const, sourceLine: 17, unifiedLine: 4 },
    { side: "head" as const, sourceLine: 23, unifiedLine: 9 },
  ]) {
    const expectedResource =
      sample.side === "base"
        ? reviewBaseFileUri(session, "src/example.ts")
        : reviewHeadFileUri(session, "src/example.ts");
    assert.ok(expectedResource);
    let disposed = false;
    const sourceModel = {
      uri: expectedResource,
      getLanguageId: () => "typescript",
      validatePosition: (position: Position) => position,
    };
    const resources = {
      unifiedResource: (resource: URI) =>
        resource.toString() === unifiedResource.toString()
          ? {
              targetForRange: (startLine: number, endLine: number) => {
                assert.equal(startLine, sample.unifiedLine);
                assert.equal(endLine, sample.unifiedLine);
                return {
                  path: "src/example.ts",
                  side: sample.side,
                  startLine: sample.sourceLine,
                  endLine: sample.sourceLine,
                };
              },
            }
          : undefined,
      target: async (path: string, side: string) => {
        assert.equal(path, "src/example.ts");
        assert.equal(side, sample.side);
        return {
          resource: expectedResource,
          workingTreeFallback: false,
        };
      },
    };
    const textModelService = {
      createModelReference: async (resource: URI) => {
        assert.equal(resource.toString(), expectedResource.toString());
        return {
          object: { textEditorModel: sourceModel },
          dispose: () => {
            disposed = true;
          },
        };
      },
    };
    const unifiedModel = {
      uri: unifiedResource,
      validateRange: (range: Range) => range,
    };
    let activated = false;
    const definitionCalls: Position[] = [];
    const definitions = await provideReviewUnifiedDefinition(
      resources as never,
      textModelService as never,
      {
        activateByEvent: async (event: string) => {
          assert.equal(event, "onLanguage:typescript");
          activated = true;
        },
      } as never,
      {} as never,
      unifiedModel as never,
      new Position(sample.unifiedLine, 8),
      CancellationToken.None,
      async (_providers, model, position, recursive, token) => {
        assert.equal(activated, true);
        assert.strictEqual(model, sourceModel);
        assert.equal(recursive, false);
        assert.strictEqual(token, CancellationToken.None);
        definitionCalls.push(position);
        if (definitionCalls.length === 1) {
          assert.deepEqual(position, new Position(sample.sourceLine, 8));
          return [
            {
              uri: expectedResource,
              range: new Range(2, 10, 2, 24),
              targetSelectionRange: new Range(2, 10, 2, 24),
              originSelectionRange: new Range(
                sample.sourceLine,
                7,
                sample.sourceLine,
                15,
              ),
            },
          ];
        }
        assert.deepEqual(position, new Position(2, 10));
        return [
          {
            uri: URI.file("/tmp/definition.ts"),
            range: new Range(2, 1, 2, 12),
            originSelectionRange: new Range(
              sample.sourceLine,
              7,
              sample.sourceLine,
              15,
            ),
          },
        ];
      },
    );

    assert.equal(definitions.length, 1);
    assert.equal(
      definitions[0]?.uri.toString(),
      URI.file("/tmp/definition.ts").toString(),
    );
    assert.deepEqual(
      definitions[0]?.originSelectionRange,
      new Range(sample.unifiedLine, 7, sample.unifiedLine, 15),
    );
    assert.equal(disposed, true);
  }
});

test("unified hovers delegate base and head rows to their pinned models", async () => {
  Object.assign(globalThis, {
    window: globalThis,
    location: { href: "http://localhost/" },
  });
  const { provideReviewUnifiedHover } = await import(
    "./reviewUnifiedDefinition.js"
  );
  const unifiedResource = URI.from({
    scheme: "devfast-review-unified",
    path: "/src/example.ts",
  });

  for (const sample of [
    {
      side: "base" as const,
      sourceLine: 17,
      unifiedLine: 4,
      resource: URI.file("/tmp/review-base/src/example.ts"),
    },
    {
      side: "head" as const,
      sourceLine: 23,
      unifiedLine: 9,
      resource: URI.file("/tmp/review-head/src/example.ts"),
    },
  ]) {
    let activated = false;
    let disposed = false;
    const sourceModel = {
      uri: sample.resource,
      getLanguageId: () => "typescript",
      validatePosition: (position: Position) => position,
    };
    const hover = await provideReviewUnifiedHover(
      {
        unifiedResource: () => ({
          targetForRange: () => ({
            path: "src/example.ts",
            side: sample.side,
            startLine: sample.sourceLine,
            endLine: sample.sourceLine,
          }),
        }),
        target: async (_path: string, side: string) => {
          assert.equal(side, sample.side);
          return { resource: sample.resource, workingTreeFallback: false };
        },
      } as never,
      {
        createModelReference: async (resource: URI) => {
          assert.equal(resource.toString(), sample.resource.toString());
          return {
            object: { textEditorModel: sourceModel },
            dispose: () => {
              disposed = true;
            },
          };
        },
      } as never,
      {
        activateByEvent: async (event: string) => {
          assert.equal(event, "onLanguage:typescript");
          activated = true;
        },
      } as never,
      {} as never,
      {
        uri: unifiedResource,
        validateRange: (range: Range) => range,
      } as never,
      new Position(sample.unifiedLine, 8),
      CancellationToken.None,
      async (_providers, model, position, token, recursive) => {
        assert.equal(activated, true);
        assert.strictEqual(model, sourceModel);
        assert.deepEqual(position, new Position(sample.sourceLine, 8));
        assert.strictEqual(token, CancellationToken.None);
        assert.equal(recursive, false);
        return [
          {
            contents: [{ value: "function signature" }],
            range: new Range(sample.sourceLine, 7, sample.sourceLine, 15),
          },
          { contents: [{ value: "documentation" }] },
        ];
      },
    );

    assert.deepEqual(
      hover?.contents.map((content) => content.value),
      ["function signature", "documentation"],
    );
    assert.deepEqual(
      hover?.range,
      new Range(sample.unifiedLine, 7, sample.unifiedLine, 15),
    );
    assert.equal(disposed, true);
  }
});

test("unified definition model references are disposed when delegation fails", async () => {
  Object.assign(globalThis, {
    window: globalThis,
    location: { href: "http://localhost/" },
  });
  const { provideReviewUnifiedDefinition } = await import(
    "./reviewUnifiedDefinition.js"
  );
  const unifiedResource = URI.from({
    scheme: "devfast-review-unified",
    path: "/src/example.ts",
  });
  let disposed = false;

  await assert.rejects(
    provideReviewUnifiedDefinition(
      {
        unifiedResource: () => ({
          targetForRange: () => ({
            path: "src/example.ts",
            side: "base",
            startLine: 17,
            endLine: 17,
          }),
        }),
        target: async () => ({
          resource: URI.file("/tmp/review-base/src/example.ts"),
          workingTreeFallback: false,
        }),
      } as never,
      {
        createModelReference: async () => ({
          object: {
            textEditorModel: {
              getLanguageId: () => "typescript",
              validatePosition: (position: Position) => position,
            },
          },
          dispose: () => {
            disposed = true;
          },
        }),
      } as never,
      { activateByEvent: async () => undefined } as never,
      {} as never,
      {
        uri: unifiedResource,
        validateRange: (range: Range) => range,
      } as never,
      new Position(4, 8),
      CancellationToken.None,
      async () => {
        throw new Error("definition provider failed");
      },
    ),
    /definition provider failed/,
  );
  assert.equal(disposed, true);
});
