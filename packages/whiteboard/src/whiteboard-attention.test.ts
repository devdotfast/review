import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WHITEBOARD_SCHEMA_VERSION } from "@dev.fast/whiteboard-protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  type WhiteboardRecord,
  WhiteboardRecordSchema,
} from "./review-import/legacy-record";
import {
  dismissWhiteboard,
  isWhiteboardReapable,
  markWhiteboardViewed,
  resetWhiteboardAttention,
  restoreWhiteboard,
  selectReapableWhiteboards,
  whiteboardReapsAt,
} from "./whiteboard-attention";
import type { StoredWhiteboard } from "./whiteboard-home";

const DISMISSED_AT = "2026-01-01T00:00:00.000Z";

describe("review attention deadlines", () => {
  it("has no deadline while the review is not dismissed", () => {
    expect(whiteboardReapsAt({ dismissedAt: null }, 30)).toBeNull();
  });

  it("has no deadline when retention is off", () => {
    expect(whiteboardReapsAt({ dismissedAt: DISMISSED_AT }, null)).toBeNull();
  });

  it("counts the retention days from the dismissal", () => {
    expect(whiteboardReapsAt({ dismissedAt: DISMISSED_AT }, 30)).toBe(
      "2026-01-31T00:00:00.000Z",
    );
  });

  it("has no deadline when the stamp is unreadable", () => {
    expect(whiteboardReapsAt({ dismissedAt: "not a date" }, 30)).toBeNull();
  });

  it("becomes reapable on the deadline, not before", () => {
    const review = { dismissedAt: DISMISSED_AT };
    expect(
      isWhiteboardReapable(review, 30, new Date("2026-01-30T23:59:59Z")),
    ).toBe(false);
    expect(
      isWhiteboardReapable(review, 30, new Date("2026-01-31T00:00:00Z")),
    ).toBe(true);
  });
});

describe("selecting reapable reviews", () => {
  const overdue = storedWhiteboard("overdue", { dismissedAt: DISMISSED_AT });
  const active = storedWhiteboard("active", { dismissedAt: null });
  const now = new Date("2026-03-01T00:00:00Z");

  it("selects only the dismissed reviews past their deadline", () => {
    expect(selectReapableWhiteboards([overdue, active], 30, now)).toEqual([
      overdue,
    ]);
  });

  it("selects nothing when retention is off", () => {
    expect(selectReapableWhiteboards([overdue, active], null, now)).toEqual([]);
  });
});

describe("review attention stamps", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function makeWhiteboard(
    patch: Partial<WhiteboardRecord> = {},
  ): Promise<StoredWhiteboard> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "review-attention-"));
    directories.push(dir);

    const stored = {
      dir,
      review: {
        ...storedWhiteboard("3b241101-e2bb-4255-8caf-4136c566a962", patch)
          .review,
      },
    };

    await writeFile(
      path.join(dir, "review.json"),
      JSON.stringify(stored.review),
    );

    return stored;
  }

  async function readStamps(
    stored: StoredWhiteboard,
  ): Promise<Pick<WhiteboardRecord, "viewedAt" | "dismissedAt">> {
    const raw: WhiteboardRecord = JSON.parse(
      await readFile(path.join(stored.dir, "review.json"), "utf8"),
    );

    return { viewedAt: raw.viewedAt, dismissedAt: raw.dismissedAt };
  }

  it("stamps the first view and keeps it on a later view", async () => {
    const stored = await makeWhiteboard();
    const first = await markWhiteboardViewed(stored, new Date("2026-02-01Z"));
    expect(first.review.viewedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(await readStamps(first)).toMatchObject({
      viewedAt: "2026-02-01T00:00:00.000Z",
    });

    const second = await markWhiteboardViewed(first, new Date("2026-02-09Z"));
    expect(second).toBe(first);
  });

  it("stamps a dismissal once", async () => {
    const stored = await makeWhiteboard();
    const dismissed = await dismissWhiteboard(stored, new Date("2026-02-01Z"));
    expect(dismissed.review.dismissedAt).toBe("2026-02-01T00:00:00.000Z");

    const again = await dismissWhiteboard(dismissed, new Date("2026-02-09Z"));
    expect(again).toBe(dismissed);
  });

  it("clears the dismissal on a restore", async () => {
    const stored = await makeWhiteboard();
    const dismissed = await dismissWhiteboard(stored, new Date("2026-02-01Z"));
    const restored = await restoreWhiteboard(dismissed);
    expect(restored.review.dismissedAt).toBeNull();
    expect(await readStamps(restored)).toMatchObject({ dismissedAt: null });

    expect(await restoreWhiteboard(restored)).toBe(restored);
  });

  it("clears both stamps when a publish resets the attention", async () => {
    const stored = await makeWhiteboard();
    const viewed = await markWhiteboardViewed(stored, new Date("2026-02-01Z"));
    const dismissed = await dismissWhiteboard(viewed, new Date("2026-02-02Z"));

    const reset = await resetWhiteboardAttention(dismissed);
    expect(await readStamps(reset)).toEqual({
      viewedAt: null,
      dismissedAt: null,
    });

    expect(await resetWhiteboardAttention(reset)).toBe(reset);
  });
});

function storedWhiteboard(
  uuid: string,
  patch: Partial<WhiteboardRecord> = {},
): StoredWhiteboard {
  return {
    dir: path.join(os.tmpdir(), `review-attention-${uuid}`),
    review: {
      schemaVersion: WHITEBOARD_SCHEMA_VERSION,
      uuid,
      repoKey: "repo",
      worktreePath: "/tmp/worktree",
      baseRef: "main",
      baseCommit: "0".repeat(40),
      sourceCommit: null,
      sourceIdentity: null,
      pullRequestNumber: null,
      pullRequestUrl: null,
      title: "Attention",
      sourceSession: "disabled:review",
      status: "draft",
      presentedDocumentRevision: null,
      presentedSoftwareMapRevision: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastPublishedAt: null,
      ...patch,
    },
  };
}
