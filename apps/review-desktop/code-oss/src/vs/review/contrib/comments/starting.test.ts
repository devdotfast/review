/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { CancellationToken } from "../../../base/common/cancellation.js";
import { Event } from "../../../base/common/event.js";
import { URI } from "../../../base/common/uri.js";
import {
  REVIEW_UNIFIED_SCHEME,
} from "../../common/reviewCodeResources.js";
import {
  createGitLabTextDiffPosition,
  type CreateReviewCommentInput,
  type ReviewCommentAgentActivity,
  type ReviewCommentMessage,
  type ReviewCommentStoreSnapshot,
  type ReviewLocalCommentThread,
  type ReviewDiffFileWire,
} from "../../common/reviewProtocol.js";
import type { ReviewCommentController } from "./reviewComments.contribution.js";

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

const agentActivityContextValue = "devfastReviewCommentAgentActivity";

const priorMessage: ReviewCommentMessage = {
  id: "message-1",
  by: "You",
  at: "2026-08-11T00:00:00.000Z",
  body: "Earlier question",
  agentInput: false,
};
const askMessage: ReviewCommentMessage = {
  id: "message-2",
  by: "You",
  at: "2026-08-11T00:00:01.000Z",
  body: "Ask now please",
  agentInput: true,
};
const agentReply: ReviewCommentMessage = {
  id: "message-3",
  by: "Agent",
  at: "2026-08-11T00:00:10.000Z",
  body: "Here is my answer",
  role: "agent",
  agentInput: false,
};
const askInput: CreateReviewCommentInput = {
  threadId: "thread-1",
  messageId: "message-2",
  target,
  body: "Ask now please",
  agentInput: true,
};

function snapshot(
  options: {
    readonly messages: readonly ReviewCommentMessage[];
    readonly activity: ReviewCommentAgentActivity | null;
    readonly local: boolean;
  },
): ReviewCommentStoreSnapshot {
  const thread = {
    threadId: "thread-1",
    target,
    status: "open" as const,
    messages: [...options.messages],
  };
  const localEntry: ReviewLocalCommentThread | undefined = options.local
    ? { clientStatus: "draft", thread, inputs: [askInput] }
    : undefined;
  return {
    commentThreads: new Map([["thread-1", thread]]),
    localComments: localEntry
      ? new Map([["thread-1", localEntry]])
      : new Map(),
    agentActivities: options.activity
      ? new Map([["thread-1", options.activity]])
      : new Map(),
    pendingCommentCount: localEntry ? 1 : 0,
  };
}

const startingActivity: ReviewCommentAgentActivity = {
  messageId: "message-2",
  startedAt: "2026-08-11T00:00:01.000Z",
  status: "starting",
};
const runningActivity: ReviewCommentAgentActivity = {
  messageId: "message-2",
  startedAt: "2026-08-11T00:00:01.000Z",
  status: "running",
};
const failedActivity: ReviewCommentAgentActivity = {
  messageId: "message-2",
  startedAt: "2026-08-11T00:00:01.000Z",
  status: "failed",
  error: "boom",
};

interface Harness {
  readonly controller: ReviewCommentController;
  readonly unifiedResource: URI;
  fire(threadIds: ReadonlySet<string>): void;
  setSnapshot(next: ReviewCommentStoreSnapshot): void;
  workspaceThreadIds(): string[];
}

async function createHarness(): Promise<Harness> {
  Object.assign(globalThis, { window: globalThis });
  let workspaceThreads: Array<{ readonly threadId: string }> = [];
  let snapshotListener = (_change: { threadIds: ReadonlySet<string> }) => {};
  let currentSnapshot: ReviewCommentStoreSnapshot = snapshot({
    messages: [priorMessage],
    activity: null,
    local: false,
  });
  const commentService = {
    registerCommentController() {},
    unregisterCommentController() {},
    onDidDeleteDataProvider: Event.None,
    updateComments() {},
    setWorkspaceComments(
      _owner: string,
      threads: typeof workspaceThreads,
    ) {
      workspaceThreads = threads;
    },
    removeWorkspaceComments() {},
    updateCommentingRanges() {},
  };
  const comments = {
    subscribe(listener: typeof snapshotListener) {
      snapshotListener = listener;
      return () => {};
    },
    getSnapshot() {
      return currentSnapshot;
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
  const sessionModelService = {
    activeModel: model,
    onDidChangeActiveModel: Event.None,
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
      return undefined;
    },
    async positionRowsForResourceRange() {
      return null;
    },
  };
  // Defer the import so the `window` global stub is installed first.
  const { ReviewCommentController } = await import(
    "./reviewComments.contribution.js"
  );
  const controller = new ReviewCommentController(
    commentService as never,
    sessionModelService as never,
    codeResources as never,
    { tutorialReview: null } as never,
    {
      createKey: () => ({ set() {}, reset() {}, get: () => true }),
    } as never,
  );
  return {
    controller,
    unifiedResource,
    fire: (threadIds) => snapshotListener({ threadIds }),
    setSnapshot: (next) => {
      currentSnapshot = next;
    },
    workspaceThreadIds: () => workspaceThreads.map((thread) => thread.threadId),
  };
}

test("starting agent activity should not hide existing thread messages", async () => {
  const harness = await createHarness();
  const { controller, unifiedResource, fire, setSnapshot } = harness;

  const before = await controller.getDocumentComments(
    unifiedResource,
    CancellationToken.None,
  );
  assert.equal(before.threads.length, 1, "thread is visible before ask");
  assert.equal(before.threads[0]?.threadId, "thread-1");
  assert.equal(
    before.threads[0]?.comments?.length,
    1,
    "only the prior message renders before ask",
  );
  assert.deepEqual(harness.workspaceThreadIds(), ["thread-1"]);
  const beforeThread = before.threads[0];

  setSnapshot(
    snapshot({
      messages: [priorMessage, askMessage],
      activity: startingActivity,
      local: true,
    }),
  );
  fire(new Set(["thread-1"]));

  const starting = await controller.getDocumentComments(
    unifiedResource,
    CancellationToken.None,
  );
  assert.equal(
    starting.threads.length,
    1,
    "expected existing thread to remain visible while the agent is starting",
  );
  assert.equal(starting.threads[0]?.threadId, "thread-1");
  assert.equal(
    starting.threads[0]?.comments?.length,
    2,
    "prior messages remain and no placeholder row renders while starting",
  );
  assert.ok(
    (starting.threads[0]?.comments ?? []).every(
      (comment) => comment.contextValue !== agentActivityContextValue,
    ),
    "no agent activity placeholder is shown while starting",
  );
  assert.ok(
    harness
      .workspaceThreadIds()
      .includes("thread-1"),
    "thread-1 stays in the workspace comment list while starting",
  );
  assert.notStrictEqual(
    beforeThread,
    undefined,
    "guard beforeThread for strict-equality check",
  );
  assert.strictEqual(
    starting.threads[0],
    beforeThread,
    "the same thread object is reused across the starting window (no flicker / dispose-and-recreate)",
  );

  setSnapshot(
    snapshot({
      messages: [priorMessage, askMessage, agentReply],
      activity: null,
      local: true,
    }),
  );
  fire(new Set(["thread-1"]));

  const settled = await controller.getDocumentComments(
    unifiedResource,
    CancellationToken.None,
  );
  assert.equal(settled.threads.length, 1, "thread stays visible once the agent replied");
  assert.equal(
    settled.threads[0]?.comments?.length,
    3,
    "prior messages plus the agent reply render with no activity placeholder once settled",
  );
  assert.ok(
    (settled.threads[0]?.comments ?? []).every(
      (comment) => comment.contextValue !== agentActivityContextValue,
    ),
    "no agent activity placeholder once the activity clears",
  );
  assert.strictEqual(
    settled.threads[0],
    beforeThread,
    "the same thread object is reused once the agent run settles",
  );

  controller.dispose();
});

test("running and failed agent activities keep the thread and label the placeholder", async () => {
  const harness = await createHarness();
  const { controller, unifiedResource, fire, setSnapshot } = harness;

  setSnapshot(
    snapshot({
      messages: [priorMessage, askMessage],
      activity: runningActivity,
      local: true,
    }),
  );
  fire(new Set(["thread-1"]));

  const running = await controller.getDocumentComments(
    unifiedResource,
    CancellationToken.None,
  );
  assert.equal(running.threads.length, 1, "thread stays visible while running");
  const runningComments = running.threads[0]?.comments ?? [];
  assert.equal(runningComments.length, 3, "running appends one placeholder row");
  assert.equal(runningComments.at(-1)?.body, "Running\u2026");
  assert.equal(
    runningComments.at(-1)?.contextValue,
    agentActivityContextValue,
  );

  setSnapshot(
    snapshot({
      messages: [priorMessage, askMessage],
      activity: failedActivity,
      local: true,
    }),
  );
  fire(new Set(["thread-1"]));

  const failed = await controller.getDocumentComments(
    unifiedResource,
    CancellationToken.None,
  );
  assert.equal(failed.threads.length, 1, "thread stays visible after failure");
  const failedComments = failed.threads[0]?.comments ?? [];
  assert.equal(failedComments.length, 3, "failed appends one placeholder row");
  assert.equal(failedComments.at(-1)?.body, "Failed: boom");
  assert.equal(
    failedComments.at(-1)?.contextValue,
    agentActivityContextValue,
  );

  controller.dispose();
});
