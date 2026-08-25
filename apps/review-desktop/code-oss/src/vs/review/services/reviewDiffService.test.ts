/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { ReviewDiffService } from "./reviewDiffService.js";

test("caches one parsed full-diff corpus per revision and scope", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const session = {
    session: { sessionId: "session-1", routePath: "/docs/review.mdx" },
    sessionUrl: "http://127.0.0.1:5570/sessions/session-1",
    token: "token",
  };
  const sessionModel = {
    activeModel: {
      session,
      request: async (url: string, init: RequestInit) => {
        requests.push({ url, body: JSON.parse(String(init.body)) });
        return Response.json({
          ok: true,
          files: [
            {
              path: "src/new.ts",
              previousPath: "src/old.ts",
              status: "renamed",
              additions: 2,
              deletions: 1,
              patch: "diff --git a b",
            },
          ],
        });
      },
    },
  };
  const service = new ReviewDiffService(sessionModel as never);

  const [first, concurrent] = await Promise.all([
    service.files(),
    service.files(),
  ]);
  assert.strictEqual(first, concurrent);
  assert.deepEqual(first, [
    {
      path: "src/new.ts",
      previousPath: "src/old.ts",
      status: "renamed",
      additions: 2,
      deletions: 1,
      patch: "diff --git a b",
    },
  ]);
  assert.equal(await service.patch("src/new.ts"), "diff --git a b");
  await service.prefetch();
  await service.files({ commit: "abc123" });
  assert.deepEqual(requests, [
    {
      url: "http://127.0.0.1:5570/sessions/session-1/__progressive-review/diff-files?document=%2Fdocs%2Freview.mdx",
      body: { includePatch: true },
    },
    {
      url: "http://127.0.0.1:5570/sessions/session-1/__progressive-review/diff-files?document=%2Fdocs%2Freview.mdx",
      body: { includePatch: true, commit: "abc123" },
    },
  ]);
});

test("does not cache failed diff requests", async () => {
  let attempts = 0;
  const session = {
    session: { sessionId: "session-1", routePath: "/" },
    sessionUrl: "http://127.0.0.1:5570/sessions/session-1",
    token: "token",
  };
  const service = new ReviewDiffService({
    activeModel: {
      session,
      request: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary failure");
        return Response.json({ ok: true, files: [] });
      },
    },
  } as never);

  await assert.rejects(service.files(), /temporary failure/);
  assert.deepEqual(await service.files(), []);
  assert.equal(attempts, 2);
});
