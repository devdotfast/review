/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { Event } from "../../base/common/event.js";
import { URI } from "../../base/common/uri.js";
import {
  REVIEW_BASE_SCHEME,
  REVIEW_HEAD_SCHEME,
  REVIEW_UNIFIED_SCHEME,
} from "../common/reviewCodeResources.js";
import { ReviewCodeResourceService } from "./reviewCodeResourceService.js";

test("diff targets use the pinned base and head checkouts", async () => {
  const session = {
    sessionId: "session-1",
    rootPath: "/tmp/review-worktree",
    baseRootPath: "/tmp/review-base",
    headRootPath: "/tmp/review-head",
    baseRef: "base",
    resolvedBaseRef: "base",
    headRef: "head",
    routePath: "/",
  };
  const service = new ReviewCodeResourceService(
    {
      registerTextModelContentProvider: () => ({ dispose() {} }),
    } as never,
    {} as never,
    {} as never,
    {
      activeModel: {
        session: {
          session,
          sessionUrl: "http://127.0.0.1:5570/sessions/session-1",
          token: "token",
        },
        request: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              files: [
                {
                  path: "src/new.ts",
                  previousPath: "src/old.ts",
                  status: "renamed",
                  additions: 2,
                  deletions: 2,
                },
              ],
            }),
            { status: 200 },
          ),
      },
      onDidChangeActiveModel: Event.None,
    } as never,
    {
      files: async () => [
        {
          path: "src/new.ts",
          previousPath: "src/old.ts",
          status: "renamed",
          additions: 2,
          deletions: 2,
        },
      ],
    } as never,
  );

  const base = await service.target("src/new.ts", "base");
  const head = await service.target("src/new.ts", "head");

  assert.equal(
    base.resource.toString(),
    URI.file("/tmp/review-base/src/old.ts").toString(),
  );
  assert.equal(
    head.resource.toString(),
    URI.file("/tmp/review-head/src/new.ts").toString(),
  );
  assert.equal(base.workingTreeFallback, false);
  assert.equal(head.workingTreeFallback, false);
  service.dispose();
});

const unifiedSession = {
  sessionId: "session-1",
  rootPath: "/tmp/review-worktree",
  baseRootPath: "/tmp/review-base",
  headRootPath: "/tmp/review-head",
  baseRef: "base",
  resolvedBaseRef: "base",
  headRef: "head",
  routePath: "/",
};
const unifiedDiffFile = {
  path: "src/example.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: [
    "@@ -1,3 +1,3 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    " const c = 4;",
    "",
  ].join("\n"),
};
const baseLines = ["const a = 1;", "const b = 2;", "const c = 4;"];
const headLines = ["const a = 1;", "const b = 3;", "const c = 4;"];

interface StubModel {
  readonly uri: URI;
  getLinesContent(): readonly string[];
  getLineCount(): number;
  getLanguageId(): string;
}

/**
 * Builds a `ReviewCodeResourceService` over the smallest text-model stack the
 * unified path needs: a model service that remembers what it created, a
 * resolver that hands back file-backed models, and a one-file diff service.
 */
function createUnifiedHarness() {
  const models = new Map<string, StubModel>();
  const registrations: Array<{
    readonly scheme: string;
    readonly provider: {
      provideTextContent(resource: URI): Promise<StubModel | null>;
    };
    disposed: boolean;
  }> = [];
  const referenceDisposals: string[] = [];
  let openReferences = 0;

  const fileModel = (uri: URI, lines: readonly string[]): StubModel => ({
    uri,
    getLinesContent: () => lines,
    getLineCount: () => lines.length,
    getLanguageId: () => "typescript",
  });
  models.set(
    URI.file("/tmp/review-base/src/example.ts").toString(),
    fileModel(URI.file("/tmp/review-base/src/example.ts"), baseLines),
  );
  models.set(
    URI.file("/tmp/review-head/src/example.ts").toString(),
    fileModel(URI.file("/tmp/review-head/src/example.ts"), headLines),
  );

  const textModelService = {
    registerTextModelContentProvider(
      scheme: string,
      provider: { provideTextContent(resource: URI): Promise<StubModel | null> },
    ) {
      const registration = { scheme, provider, disposed: false };
      registrations.push(registration);
      return {
        dispose() {
          registration.disposed = true;
        },
      };
    },
    async createModelReference(resource: URI) {
      const model = models.get(resource.toString());
      if (!model) throw new Error(`No model for ${resource.toString()}`);
      openReferences += 1;
      let disposed = false;
      return {
        object: { textEditorModel: model },
        dispose() {
          if (disposed) return;
          disposed = true;
          openReferences -= 1;
          referenceDisposals.push(resource.toString());
        },
      };
    },
  };
  const modelService = {
    getModel: (resource: URI) => models.get(resource.toString()) ?? null,
    createModel(content: string, _language: unknown, resource: URI) {
      const lines = content.split("\n");
      const model = fileModel(resource, lines);
      models.set(resource.toString(), model);
      return model;
    },
  };
  const service = new ReviewCodeResourceService(
    textModelService as never,
    modelService as never,
    { createById: (id: string) => ({ languageId: id }) } as never,
    {
      activeModel: {
        session: {
          session: unifiedSession,
          sessionUrl: "http://127.0.0.1:5570/sessions/session-1",
          token: "token",
        },
        request: async () => {
          throw new Error("no network in this test");
        },
      },
      onDidChangeActiveModel: Event.None,
    } as never,
    {
      files: async () => [unifiedDiffFile],
      patch: async () => unifiedDiffFile.patch,
    } as never,
  );

  return {
    service,
    registrations,
    referenceDisposals,
    openReferences: () => openReferences,
  };
}

test("unified diff resources are keyed by session and side, and shared", async () => {
  const harness = createUnifiedHarness();
  const first = await harness.service.acquireUnifiedDiff(
    "src/example.ts",
    "head",
    [],
  );
  assert.ok(first);
  const resource = first.model.uri;
  assert.equal(resource.scheme, REVIEW_UNIFIED_SCHEME);
  const query = new URLSearchParams(resource.query);
  assert.equal(query.get("path"), "src/example.ts");
  assert.equal(query.get("version"), unifiedSession.sessionId);
  assert.equal(query.get("side"), "head");

  // The identity is the session, path and side — not a per-call token — so a
  // second acquire of the same CodePeek reuses one model rather than building
  // a second copy of the unified text.
  const second = await harness.service.acquireUnifiedDiff(
    "src/example.ts",
    "head",
    [],
  );
  assert.ok(second);
  assert.strictEqual(second.model, first.model);
  assert.equal(second.model.uri.toString(), resource.toString());

  const otherSide = await harness.service.acquireUnifiedDiff(
    "src/example.ts",
    "base",
    [],
  );
  assert.ok(otherSide);
  assert.notEqual(otherSide.model.uri.toString(), resource.toString());
  assert.equal(
    new URLSearchParams(otherSide.model.uri.query).get("side"),
    "base",
  );

  otherSide.dispose();
  second.dispose();
  first.dispose();
  harness.service.dispose();
});

test("unified diff references are released only when the last holder lets go", async () => {
  const harness = createUnifiedHarness();
  const first = await harness.service.acquireUnifiedDiff(
    "src/example.ts",
    "head",
    [],
  );
  const second = await harness.service.acquireUnifiedDiff(
    "src/example.ts",
    "head",
    [],
  );
  assert.ok(first && second);
  // base checkout, head checkout, and the unified resource itself: References
  // and Peek Definition resolve the unified URI independently, so the service
  // holds its own resolver reference for as long as the CodePeek lives.
  assert.equal(harness.openReferences(), 3);
  assert.deepEqual(harness.referenceDisposals, []);

  first.dispose();
  assert.equal(harness.openReferences(), 3);

  second.dispose();
  assert.equal(harness.openReferences(), 0);
  assert.deepEqual(
    new Set(harness.referenceDisposals),
    new Set([
      first.model.uri.toString(),
      URI.file("/tmp/review-base/src/example.ts").toString(),
      URI.file("/tmp/review-head/src/example.ts").toString(),
    ]),
  );
  harness.service.dispose();
});

test("unified rows resolve back to the pinned base and head checkouts", async () => {
  const harness = createUnifiedHarness();
  const reference = await harness.service.acquireUnifiedDiff(
    "src/example.ts",
    "head",
    [],
  );
  assert.ok(reference);
  const info = harness.service.unifiedResource(reference.model.uri);
  assert.ok(info);
  assert.deepEqual(
    info.rows.map((row) => [row.kind, row.authorSide, row.authorLine]),
    [
      ["unchanged", "head", 1],
      ["deleted", "base", 2],
      ["added", "head", 2],
      ["unchanged", "head", 3],
    ],
  );

  const deleted = info.targetForRange(2, 2);
  const added = info.targetForRange(3, 3);
  assert.deepEqual(deleted, {
    path: "src/example.ts",
    side: "base",
    startLine: 2,
    endLine: 2,
  });
  assert.deepEqual(added, {
    path: "src/example.ts",
    side: "head",
    startLine: 2,
    endLine: 2,
  });
  // A row that spans both sides has no single source line to open.
  assert.equal(info.targetForRange(2, 3), null);

  const deletedTarget = await harness.service.target(
    deleted!.path,
    deleted!.side,
  );
  const addedTarget = await harness.service.target(added!.path, added!.side);
  assert.equal(
    deletedTarget.resource.toString(),
    URI.file("/tmp/review-base/src/example.ts").toString(),
  );
  assert.equal(
    addedTarget.resource.toString(),
    URI.file("/tmp/review-head/src/example.ts").toString(),
  );

  reference.dispose();
  harness.service.dispose();
});

test("the review scheme content providers are registered and disposed with the service", async () => {
  const harness = createUnifiedHarness();
  assert.deepEqual(
    harness.registrations.map((registration) => registration.scheme),
    [REVIEW_BASE_SCHEME, REVIEW_HEAD_SCHEME, REVIEW_UNIFIED_SCHEME],
  );

  const reference = await harness.service.acquireUnifiedDiff(
    "src/example.ts",
    "head",
    [],
  );
  assert.ok(reference);
  const unifiedProvider = harness.registrations.find(
    (registration) => registration.scheme === REVIEW_UNIFIED_SCHEME,
  );
  assert.ok(unifiedProvider);
  // The unified text lives in the model service already; the provider hands
  // the same model back so a resolver reference never rebuilds it.
  assert.strictEqual(
    await unifiedProvider.provider.provideTextContent(reference.model.uri),
    reference.model,
  );
  assert.equal(
    reference.model.getLinesContent().join("\n"),
    ["const a = 1;", "const b = 2;", "const b = 3;", "const c = 4;"].join("\n"),
  );

  reference.dispose();
  harness.service.dispose();
  assert.deepEqual(
    harness.registrations.map((registration) => registration.disposed),
    [true, true, true],
  );
});
