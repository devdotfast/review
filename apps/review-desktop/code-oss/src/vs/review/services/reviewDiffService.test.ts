/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { ReviewDiffService } from "./reviewDiffService.js";

test("loads parsed file metadata and patches through one service", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const session = {
    session: { sessionId: "session-1", routePath: "/docs/review.mdx" },
    sessionUrl: "http://127.0.0.1:5570/sessions/session-1",
    token: "token",
  };
  const service = new ReviewDiffService({
    activeModel: {
      session,
      request: async (url: string, init: RequestInit) => {
        requests.push({ url, body: JSON.parse(String(init.body)) });
        const body = JSON.parse(String(init.body)) as {
          includePatch: boolean;
        };
        return Response.json({
          ok: true,
          files: [
            {
              path: "src/new.ts",
              previousPath: "src/old.ts",
              status: "renamed",
              additions: 2,
              deletions: 1,
              ...(body.includePatch ? { patch: "diff --git a b" } : {}),
            },
          ],
        });
      },
    },
  } as never);

  assert.deepEqual(await service.files({ commit: "abc123" }), [
    {
      path: "src/new.ts",
      previousPath: "src/old.ts",
      status: "renamed",
      additions: 2,
      deletions: 1,
    },
  ]);
  assert.equal(await service.patch("src/new.ts"), "diff --git a b");
  assert.deepEqual(requests, [
    {
      url: "http://127.0.0.1:5570/sessions/session-1/__progressive-review/diff-files?document=%2Fdocs%2Freview.mdx",
      body: { includePatch: false, commit: "abc123" },
    },
    {
      url: "http://127.0.0.1:5570/sessions/session-1/__progressive-review/diff-files?document=%2Fdocs%2Freview.mdx",
      body: { includePatch: true, paths: ["src/new.ts"] },
    },
  ]);
});
