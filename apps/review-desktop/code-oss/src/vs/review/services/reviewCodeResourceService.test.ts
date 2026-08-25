/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { Event } from "../../base/common/event.js";
import { URI } from "../../base/common/uri.js";
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
