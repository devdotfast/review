/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { CancellationToken } from "../../base/common/cancellation.js";
import { Emitter, Event } from "../../base/common/event.js";
import { URI } from "../../base/common/uri.js";
import { Range } from "../../editor/common/core/range.js";
import {
  REVIEW_BASE_SCHEME,
  REVIEW_HEAD_SCHEME,
  REVIEW_UNIFIED_SCHEME,
  reviewVirtualUri,
} from "../common/reviewCodeResources.js";
import {
  createGitLabTextDiffPosition,
  type ReviewCommentStoreSnapshot,
  type ReviewDiffFileWire,
} from "../common/reviewProtocol.js";

const baseSha = "0000000000000000000000000000000000000000";
const headSha = "1111111111111111111111111111111111111111";
const path = "src/example.ts";
const sessionId = "session-1";
const diffFile: ReviewDiffFileWire = {
  path,
  status: "modified",
  additions: 3,
  deletions: 4,
};
const position = createGitLabTextDiffPosition({
  base_sha: baseSha,
  start_sha: baseSha,
  head_sha: headSha,
  old_path: path,
  new_path: path,
  start: { old_line: 267, new_line: null },
  end: { old_line: null, new_line: 322 },
});
const target = { kind: "code" as const, original_position: position, position };
const snapshot: ReviewCommentStoreSnapshot = {
  commentThreads: new Map([
    [
      "thread-1",
      {
        threadId: "thread-1",
        target,
        status: "open",
        messages: [
          {
            id: "message-1",
            by: "You",
            at: "2026-08-11T00:00:00.000Z",
            body: "Cross-side comment",
            agentInput: false,
          },
        ],
      },
    ],
  ]),
  localComments: new Map(),
  agentActivities: new Map(),
  pendingCommentCount: 0,
};

test("keeps one stable comment projection per diff resource", async () => {
  Object.assign(globalThis, { window: globalThis });
  const { ReviewCommentController } = await import(
    "../contrib/comments/reviewComments.contribution.js"
  );
  const commentEvents: unknown[] = [];
  let workspaceComments: Array<{
    readonly threadId: string;
    readonly resource: string;
    readonly range: unknown;
  }> = [];
  let snapshotListener = (_change: { threadIds: ReadonlySet<string> }) => {};
  let currentSnapshot = snapshot;
  const savedComments: unknown[] = [];
  let commentingRangeUpdates = 0;
  const commentService = {
    registerCommentController() {},
    unregisterCommentController() {},
    onDidDeleteDataProvider: Event.None,
    updateComments(_owner: string, event: unknown) {
      commentEvents.push(event);
    },
    setWorkspaceComments(_owner: string, threads: typeof workspaceComments) {
      workspaceComments = threads;
    },
    removeWorkspaceComments() {},
    updateCommentingRanges() {
      commentingRangeUpdates += 1;
    },
  };
  const comments = {
    subscribe(listener: typeof snapshotListener) {
      snapshotListener = listener;
      return () => {};
    },
    getSnapshot() {
      return currentSnapshot;
    },
    async saveComment(input: unknown) {
      savedComments.push(input);
    },
  };
  const model = {
    state: "active",
    session: {
      session: {
        sessionId,
        resolvedBaseRef: baseSha,
        headRef: headSha,
        headRootPath: "/tmp/review-head",
      },
    },
    comments,
  };
  const activeModelChange = new Emitter<typeof model | null>();
  const sessionModelService = {
    activeModel: model,
    onDidChangeActiveModel: activeModelChange.event,
  };
  const unifiedResource = URI.from({
    scheme: REVIEW_UNIFIED_SCHEME,
    path: `/${path}`,
    query: `version=${sessionId}`,
  });
  const codeResources = {
    async files() {
      return [diffFile];
    },
    unifiedResource(resource: URI) {
      if (resource.toString() !== unifiedResource.toString()) return null;
      return {
        path,
        diffFile,
        rows: [],
        commentingRanges: [{ startLine: 1, endLine: 10 }],
        targetForRange: () => null,
        rangeForTarget: () => undefined,
        positionRowsForRange: () => null,
        rangeForPositionRows: () => ({ startLine: 3, endLine: 9 }),
      };
    },
    async projectPosition(_position: unknown, resource: URI) {
      if (resource.toString() === unifiedResource.toString()) {
        return { startLine: 3, endLine: 9 };
      }
      if (resource.scheme === REVIEW_BASE_SCHEME) {
        return resource.path === `/${path}`
          ? { startLine: 267, endLine: 270 }
          : undefined;
      }
      if (resource.scheme === REVIEW_HEAD_SCHEME) {
        return resource.path === `/${path}`
          ? { startLine: 320, endLine: 322 }
          : undefined;
      }
      return undefined;
    },
    async positionRowsForResourceRange(
      resource: URI,
      startLine: number,
      endLine: number,
    ) {
      if (
        resource.toString() !== unifiedResource.toString() ||
        startLine !== 3 ||
        endLine !== 9
      ) {
        return null;
      }
      return {
        diffFile,
        start: { old_line: 267, new_line: null },
        end: { old_line: null, new_line: 322 },
      };
    },
  };
  const controller = new ReviewCommentController(
    commentService as never,
    sessionModelService as never,
    codeResources as never,
    { tutorialReview: null } as never,
    {
      createKey: () => ({
        set() {},
        reset() {},
        get: () => true,
      }),
    } as never,
  );
  assert.equal(commentingRangeUpdates, 1);
  const baseResource = reviewVirtualUri(
    "base",
    path,
    path,
    sessionId,
  );
  const headResource = reviewVirtualUri(
    "head",
    path,
    path,
    sessionId,
  );

  assert.equal(baseResource.scheme, REVIEW_BASE_SCHEME);
  assert.equal(headResource.scheme, REVIEW_HEAD_SCHEME);
  const unified = await controller.getDocumentComments(
    unifiedResource,
    CancellationToken.None,
  );
  const base = await controller.getDocumentComments(
    baseResource,
    CancellationToken.None,
  );
  const head = await controller.getDocumentComments(
    headResource,
    CancellationToken.None,
  );
  const baseAgain = await controller.getDocumentComments(
    baseResource,
    CancellationToken.None,
  );
  const unrelated = await controller.getDocumentComments(
    reviewVirtualUri("head", "src/other.ts", "src/other.ts", sessionId),
    CancellationToken.None,
  );

  assert.equal(unified.threads.length, 1);
  assert.equal(base.threads.length, 1);
  assert.equal(head.threads.length, 1);
  assert.equal(unrelated.threads.length, 0);
  assert.strictEqual(baseAgain.threads[0], base.threads[0]);
  assert.notStrictEqual(base.threads[0], head.threads[0]);
  assert.equal(base.threads[0].resource, baseResource.toString());
  assert.equal(head.threads[0].resource, headResource.toString());
  assert.equal(base.threads[0].label, "L267\u2013270 \u00b7 base");
  assert.equal(head.threads[0].label, "L320\u2013322 \u00b7 head");
  assert.equal(unified.threads[0].label, "L3\u20139 \u00b7 diff");
  assert.deepEqual(base.threads[0].range, new Range(267, 1, 270, Number.MAX_SAFE_INTEGER));
  assert.deepEqual(head.threads[0].range, new Range(320, 1, 322, Number.MAX_SAFE_INTEGER));
  currentSnapshot = {
    ...snapshot,
    agentActivities: new Map([
      [
        "thread-1",
        {
          messageId: "message-1",
          startedAt: "2026-08-11T00:00:01.000Z",
          status: "running" as const,
        },
      ],
    ]),
  };
  snapshotListener({ threadIds: new Set(["thread-1"]) });
  assert.equal(commentingRangeUpdates, 1);

  assert.equal(commentEvents.length, 1);
  const event = commentEvents[0] as {
    readonly added: unknown[];
    readonly changed: Array<{ readonly resource: string }>;
  };
  assert.deepEqual(event.added, []);
  assert.deepEqual(
    new Set(event.changed.map((thread) => thread.resource)),
    new Set([
      unifiedResource.toString(),
      baseResource.toString(),
      headResource.toString(),
    ]),
  );
  const eventCount = commentEvents.length;
  await controller.createCommentThreadTemplate(
    unifiedResource,
    new Range(3, 1, 9, 1),
  );
  const templateEvent = commentEvents[eventCount] as {
    readonly added: Array<{
      readonly isTemplate: boolean;
      readonly threadId: string;
      readonly resource: string;
      readonly range: unknown;
    }>;
  };
  const template = templateEvent.added[0]!;
  assert.equal(template.isTemplate, true);
  await controller.addToReview({
    thread: template as never,
    text: "New comment",
  });
  const saved = savedComments[0] as {
    readonly target: typeof target;
  };
  assert.deepEqual(saved.target.position.line_range, position.line_range);

  const templateThread = template;
  currentSnapshot = {
    commentThreads: new Map([
      ...snapshot.commentThreads,
      [
        templateThread.threadId,
        {
          threadId: templateThread.threadId,
          target,
          status: "open" as const,
          messages: [
            {
              id: "message-2",
              by: "You",
              at: "2026-08-11T00:00:02.000Z",
              body: "New comment",
              agentInput: false,
            },
          ],
        },
      ],
    ]),
    localComments: new Map(),
    agentActivities: new Map(),
    pendingCommentCount: 0,
  };
  snapshotListener({ threadIds: new Set([templateThread.threadId]) });
  assert.equal(commentingRangeUpdates, 1);

  const storedWorkspaceThread = workspaceComments.find(
    (thread) => thread.threadId === templateThread.threadId,
  );
  assert.ok(storedWorkspaceThread);
  assert.notStrictEqual(storedWorkspaceThread, templateThread);
  const workspaceResource = URI.parse(storedWorkspaceThread.resource);
  assert.equal(workspaceResource.scheme, REVIEW_UNIFIED_SCHEME);
  assert.equal(
    new URLSearchParams(workspaceResource.query).get("workspace"),
    "true",
  );
  assert.equal(storedWorkspaceThread.range, undefined);

  const storedUnified = await controller.getDocumentComments(
    unifiedResource,
    CancellationToken.None,
  );
  const storedResourceThread = storedUnified.threads.find(
    (thread) => thread.threadId === templateThread.threadId,
  );
  assert.strictEqual(storedResourceThread, templateThread);
  assert.equal(storedResourceThread?.isTemplate, false);
  activeModelChange.fire(model);
  assert.equal(commentingRangeUpdates, 1);
  controller.dispose();
});
