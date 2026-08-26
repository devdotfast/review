import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { createReviewDir } from "./review-home";
import { runReviewRebind } from "./review-rebind";
import { runReviewScaffold } from "./review-scaffold";
import { reviewSourceHeadRef } from "./review-source-ref";
import { appendReviewComment, updateReviewComment } from "./review-state-store";
import { closeAllReviewThreadStores } from "./review-thread-store-backend";
import { resolveReviewInfo } from "./server/review-info";

const execFilePromise = promisify(execFile);
const createReviewSourceAgentSession = vi.hoisted(() =>
  vi.fn<
    (input: {
      agent: { harness: string; sessionId: string };
    }) => Promise<{ harness: string; sessionId: string }>
  >(async ({ agent }: { agent: { harness: string; sessionId: string } }) => ({
    harness: agent.harness,
    sessionId: `${agent.sessionId}-fork`,
  })),
);

vi.mock("./review-source-agent-session", () => ({
  createReviewSourceAgentSession,
}));

describe("review info", () => {
  it("returns an empty list without creating a review", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-info-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
      await expect(
        resolveReviewInfo({
          cwd: root,
        }),
      ).resolves.toEqual({
        event: "info",
        reviews: [],
      });
      await expect(
        readFile(path.join(home, "reviews"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("scaffolds a distinct UUID review and info reports it with comment state", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-info-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
      const created = await runReviewScaffold({
        cwd: root,
        env: { CODEX_THREAD_ID: "thread-1" },
      });

      expect(created).toMatchObject({
        event: "info",
        reviews: [
          {
            uuid: expect.stringMatching(/^[0-9a-f-]{36}$/),
            change: expect.any(String),
            inSync: true,
            matchesCheckout: true,
            unresolvedComments: 0,
            status: "draft",
            title: "Progressive Review",
          },
        ],
      });

      const reviewJson = JSON.parse(
        await readFile(
          path.join(created.reviews[0]!.dir, "review.json"),
          "utf8",
        ),
      );
      expect(reviewJson.sourceSession).toBe("codex:thread-1-fork");
      expect(reviewJson.baseRef).toEqual(expect.any(String));
      expect(created.reviews[0]?.change).toBe(reviewJson.sourceIdentity?.name);
      await expect(
        git(root, ["rev-parse", reviewSourceHeadRef(created.reviews[0]!.uuid)]),
      ).resolves.toBe(reviewJson.sourceCommit);
      const document = path.join(created.reviews[0]!.dir, "review.mdx");
      for (const threadId of ["open-thread", "resolved-thread"]) {
        appendReviewComment(document, {
          threadId,
          messageId: `${threadId}-message`,
          target: { kind: "document" },
          body: "Please take a look.",
          author: "Reviewer",
        });
      }
      updateReviewComment(document, "resolved-thread", { status: "resolved" });

      const reused = await resolveReviewInfo({ cwd: root });
      expect(reused.reviews).toHaveLength(1);
      expect(reused.reviews[0]).toMatchObject({
        uuid: created.reviews[0]?.uuid,
        dir: created.reviews[0]?.dir,
        unresolvedComments: 1,
      });
    } finally {
      vi.unstubAllEnvs();
      closeAllReviewThreadStores();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("materializes available agent traces and reports their paths", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-info-home-"));
    const mockR2Dir = path.join(home, "mock-r2");
    const traceSearchDir = path.join(home, "trace-search");
    const traceSettingsPath = path.join(home, "trace-settings.json");
    const sessionId = "11111111-1111-4111-8111-111111111111";
    vi.stubEnv("DEV_REVIEW_HOME", home);
    vi.stubEnv("TRACE_R2_MODE", "mock");
    vi.stubEnv("TRACE_R2_MOCK_DIR", mockR2Dir);
    vi.stubEnv("TRACE_SETTINGS_FILE", traceSettingsPath);
    vi.stubEnv("REVIEW_TEST_TRACE_SEARCH_DIR", traceSearchDir);
    vi.stubEnv("GITHUB_REPOSITORY", "acme/widgets");

    try {
      await writeFile(
        traceSettingsPath,
        JSON.stringify({
          version: 1,
          enabled: true,
          autoActivateRepositories: true,
        }),
      );
      await git(root, ["config", "devfast.prepare", "echo ok"]);
      await git(root, ["checkout", "-b", "feature"]);
      await writeFile(path.join(root, "README.md"), "# Feature\n", "utf8");
      await git(root, [
        "commit",
        "-am",
        `feature\n\nAgent-Session: ${sessionId}`,
      ]);

      const remoteTraceDir = path.join(mockR2Dir, "by-session", sessionId);
      await mkdir(remoteTraceDir, { recursive: true });
      await writeFile(
        path.join(remoteTraceDir, "trace.jsonl"),
        [
          JSON.stringify({
            type: "session_meta",
            payload: { id: sessionId, cwd: root },
          }),
          JSON.stringify({
            type: "event_msg",
            payload: { type: "user_message", message: "Build the feature" },
          }),
        ].join("\n") + "\n",
      );

      const progress: string[] = [];
      const created = await runReviewScaffold({
        cwd: root,
        baseRef: "main",
        headRef: "feature",
        progress: (message) => progress.push(message),
      });
      const expectedPath = path.join(
        traceSearchDir,
        "acme",
        "widgets",
        sessionId,
        "main.jsonl",
      );

      expect(created.traces).toMatchObject({
        sessions: [
          {
            id: sessionId,
            available: true,
            traces: ["main"],
          },
        ],
        corpusRoot: traceSearchDir,
        repository: "acme/widgets",
        materializedSessions: [
          { session: sessionId, traces: 1, events: 1, files: 1 },
        ],
        unavailableSessions: [],
        events: 1,
        files: 1,
        paths: [expectedPath],
      });
      expect(progress).toContain("Trace paths:");
      expect(progress).toContain(`  ${expectedPath}`);
      await expect(readFile(expectedPath, "utf8")).resolves.toContain(
        '"repository":"acme/widgets"',
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists a worktree review when the checkout does not match its change", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-info-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
      await git(root, ["checkout", "-b", "feature"]);
      await writeFile(path.join(root, "README.md"), "# Feature\n", "utf8");
      await git(root, ["commit", "-am", "feature"]);
      await git(root, ["checkout", "main"]);

      const created = await runReviewScaffold({
        cwd: root,
        baseRef: "main",
        headRef: "feature",
      });
      expect(created.reviews[0]).toMatchObject({
        inSync: false,
        matchesCheckout: false,
      });

      const discovered = await resolveReviewInfo({ cwd: root });
      expect(discovered.reviews).toHaveLength(1);
      expect(discovered.reviews[0]).toMatchObject({
        uuid: created.reviews[0]!.uuid,
        inSync: false,
        matchesCheckout: false,
      });

      await git(root, ["checkout", "feature"]);
      await expect(resolveReviewInfo({ cwd: root })).resolves.toMatchObject({
        reviews: [
          {
            uuid: created.reviews[0]!.uuid,
            inSync: true,
            matchesCheckout: true,
          },
        ],
      });
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds only after creation persists and as soon as an update target resolves", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-info-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
      const createdBindings: string[] = [];
      const created = await runReviewScaffold({
        cwd: root,
        onReviewBound: async (uuid) => {
          await readFile(
            path.join(home, "reviews", uuid, "review.json"),
            "utf8",
          );
          createdBindings.push(uuid);
        },
      });
      expect(createdBindings).toEqual([created.reviews[0]!.uuid]);

      const updateBindings: string[] = [];
      await expect(
        runReviewScaffold({
          cwd: root,
          update: true,
          reviewUuid: created.reviews[0]!.uuid,
          baseRef: "missing-review-base",
          onReviewBound: (uuid) => {
            updateBindings.push(uuid);
          },
        }),
      ).rejects.toThrow("missing-review-base");
      expect(updateBindings).toEqual([created.reviews[0]!.uuid]);
    } finally {
      vi.unstubAllEnvs();
      closeAllReviewThreadStores();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks a duplicate active review unless --new is present", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-info-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
      const initial = await runReviewScaffold({ cwd: root });
      const refsBefore = await git(root, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/dev-fast/reviews",
      ]);
      const directoriesBefore = await readdir(path.join(home, "reviews"));
      await expect(runReviewScaffold({ cwd: root })).rejects.toThrow(
        new RegExp(`${initial.reviews[0]!.uuid}.*--update.*--review.*--new`),
      );
      expect(
        await git(root, [
          "for-each-ref",
          "--format=%(refname)",
          "refs/dev-fast/reviews",
        ]),
      ).toBe(refsBefore);
      expect(await readdir(path.join(home, "reviews"))).toEqual(
        directoriesBefore,
      );
      const next = await runReviewScaffold({ cwd: root, newReview: true });

      expect(next.reviews).toHaveLength(1);
      expect(next.reviews[0]?.uuid).not.toBe(initial.reviews[0]?.uuid);
      const duplicateError = await runReviewScaffold({ cwd: root }).then(
        () => "",
        (error: unknown) => String(error),
      );
      expect(duplicateError).toContain(initial.reviews[0]!.uuid);
      expect(duplicateError).toContain(next.reviews[0]!.uuid);
      expect(duplicateError).toContain("--new");
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows plain scaffold for a different source or terminal prior review", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-info-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    try {
      const initial = await runReviewScaffold({ cwd: root });
      await git(root, ["checkout", "-b", "feature"]);
      const different = await runReviewScaffold({ cwd: root });
      expect(different.reviews[0]?.uuid).not.toBe(initial.reviews[0]?.uuid);
      const recordPath = path.join(different.reviews[0]!.dir, "review.json");
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      await writeFile(
        recordPath,
        `${JSON.stringify({ ...record, status: "accepted" }, null, 2)}\n`,
      );
      const afterTerminal = await runReviewScaffold({ cwd: root });
      expect(afterTerminal.reviews[0]?.uuid).not.toBe(
        different.reviews[0]?.uuid,
      );
      const rejectedPath = path.join(
        afterTerminal.reviews[0]!.dir,
        "review.json",
      );
      const rejected = JSON.parse(await readFile(rejectedPath, "utf8"));
      await writeFile(
        rejectedPath,
        `${JSON.stringify({ ...rejected, status: "rejected" }, null, 2)}\n`,
      );
      await expect(runReviewScaffold({ cwd: root })).resolves.toMatchObject({
        reviews: [{ status: "draft" }],
      });
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stores the merge base for an explicit symbolic base", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-info-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
      const forkPoint = await git(root, ["rev-parse", "HEAD"]);
      await git(root, ["checkout", "-b", "feature"]);
      await writeFile(path.join(root, "README.md"), "# Feature\n", "utf8");
      await git(root, ["commit", "-am", "feature"]);
      await git(root, ["checkout", "main"]);
      await writeFile(path.join(root, "README.md"), "# Main\n", "utf8");
      await git(root, ["commit", "-am", "main advance"]);
      const mainTip = await git(root, ["rev-parse", "HEAD"]);
      await git(root, ["checkout", "feature"]);

      const created = await runReviewScaffold({
        cwd: root,
        baseRef: "main",
        headRef: "feature",
      });
      const reviewJson = JSON.parse(
        await readFile(
          path.join(created.reviews[0]!.dir, "review.json"),
          "utf8",
        ),
      );

      expect(reviewJson.baseRef).toBe("main");
      expect(reviewJson.baseCommit).toBe(forkPoint);
      expect(reviewJson.baseCommit).not.toBe(mainTip);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("re-pins an existing review with scaffold --update", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-info-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
      const forkPoint = await git(root, ["rev-parse", "HEAD"]);
      await git(root, ["checkout", "-b", "feature"]);
      await writeFile(path.join(root, "README.md"), "# Feature\n", "utf8");
      await git(root, ["commit", "-am", "feature"]);

      const created = await runReviewScaffold({
        cwd: root,
        baseRef: "main",
        headRef: "feature",
      });
      const uuid = created.reviews[0]!.uuid;

      await writeFile(path.join(root, "README.md"), "# Feature 2\n", "utf8");
      await git(root, ["commit", "-am", "feature 2"]);
      const movedHead = await git(root, ["rev-parse", "HEAD"]);
      await git(root, ["checkout", "main"]);
      await writeFile(path.join(root, "other.txt"), "main\n", "utf8");
      await git(root, ["add", "."]);
      await git(root, ["commit", "-m", "main advance"]);
      const movedMain = await git(root, ["rev-parse", "HEAD"]);
      await git(root, ["checkout", "feature"]);

      const updated = await runReviewScaffold({
        cwd: root,
        update: true,
        env: { CLAUDE_CODE_SESSION_ID: "update-1" },
      });
      expect(updated.reviews).toHaveLength(1);
      expect(updated.reviews[0]?.uuid).toBe(uuid);
      const reviewJson = JSON.parse(
        await readFile(
          path.join(updated.reviews[0]!.dir, "review.json"),
          "utf8",
        ),
      );
      expect(reviewJson.sourceCommit).toBe(movedHead);
      expect(reviewJson.baseCommit).toBe(forkPoint);
      expect(reviewJson.baseRef).toBe("main");
      expect(reviewJson.sourceSession).toBe("claude-code:update-1-fork");

      const rebased = await runReviewScaffold({
        cwd: root,
        update: true,
        baseRef: movedMain,
      });
      const rebasedJson = JSON.parse(
        await readFile(
          path.join(rebased.reviews[0]!.dir, "review.json"),
          "utf8",
        ),
      );
      expect(rebasedJson.baseRef).toBe(movedMain);
      expect(rebasedJson.baseCommit).toBe(forkPoint);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports anchors whose source files changed during scaffold update", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-info-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
      await git(root, ["checkout", "-b", "feature"]);
      const created = await runReviewScaffold({
        cwd: root,
        baseRef: "main",
        headRef: "feature",
      });
      const reviewDir = created.reviews[0]!.dir;
      await writeFile(
        path.join(reviewDir, "data.ts"),
        [
          'import { defineAnchors } from "virtual:progressive-review-authoring";',
          "export const anchors = defineAnchors({",
          "  evidence: {",
          '    title: "Evidence",',
          '    peek: { file: "README.md", fromLine: 1, toLine: 1 },',
          "  },",
          "});",
        ].join("\n"),
      );
      await writeFile(
        path.join(reviewDir, "review.mdx"),
        [
          'import { anchors } from "./data";',
          "",
          "# Range update",
          "",
          "<CodePeek anchor={anchors.evidence} />",
        ].join("\n"),
      );

      await writeFile(path.join(root, "README.md"), "# Changed\n", "utf8");
      await git(root, ["commit", "-am", "change evidence"]);
      const progress = vi.fn<(message: string) => void>();

      await runReviewScaffold({ cwd: root, update: true, progress });

      expect(progress).toHaveBeenCalledWith(
        "anchor `evidence`: `README.md` changed between pins — re-read and adjust the range.",
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pins a mid-stack review to its bound branch, not the checkout", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-info-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
      const forkPoint = await git(root, ["rev-parse", "HEAD"]);
      await git(root, ["checkout", "-b", "feat-a"]);
      await writeFile(path.join(root, "a.txt"), "a\n", "utf8");
      await git(root, ["add", "."]);
      await git(root, ["commit", "-m", "a"]);
      const featATip = await git(root, ["rev-parse", "HEAD"]);
      await git(root, ["checkout", "-b", "feat-b"]);
      await writeFile(path.join(root, "b.txt"), "b\n", "utf8");
      await git(root, ["add", "."]);
      await git(root, ["commit", "-m", "b"]);
      const featBTip = await git(root, ["rev-parse", "HEAD"]);

      // Scaffold the mid-stack review while checked out at the stack top.
      const created = await runReviewScaffold({
        cwd: root,
        baseRef: "main",
        headRef: "feat-a",
      });
      const uuid = created.reviews[0]!.uuid;
      const createdJson = JSON.parse(
        await readFile(
          path.join(created.reviews[0]!.dir, "review.json"),
          "utf8",
        ),
      );
      expect(createdJson.sourceCommit).toBe(featATip);
      expect(createdJson.sourceCommit).not.toBe(featBTip);
      expect(createdJson.baseCommit).toBe(forkPoint);

      // Advance the mid-stack branch, then update from the stack top. The
      // branch moves within local-vcs's read-query cache TTL, so drop the
      // cache the way a fresh CLI process would.
      await git(root, ["checkout", "feat-a"]);
      await writeFile(path.join(root, "a.txt"), "a2\n", "utf8");
      await git(root, ["commit", "-am", "a2"]);
      const movedFeatATip = await git(root, ["rev-parse", "HEAD"]);
      await git(root, ["checkout", "feat-b"]);

      const updated = await runReviewScaffold({
        cwd: root,
        update: true,
        reviewUuid: uuid,
      });
      const updatedJson = JSON.parse(
        await readFile(
          path.join(updated.reviews[0]!.dir, "review.json"),
          "utf8",
        ),
      );
      expect(updatedJson.sourceCommit).toBe(movedFeatATip);
      expect(updatedJson.sourceCommit).not.toBe(featBTip);
      expect(updatedJson.baseCommit).toBe(forkPoint);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("defaults the jj base to the trunk fork point, not the parent change", async () => {
    if (!(await commandAvailable("jj"))) return;
    const root = await mkdtemp(path.join(os.tmpdir(), "review-info-jj-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "review-info-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
      await jj(root, ["git", "init"]);
      await writeFile(path.join(root, "README.md"), "base\n", "utf8");
      await jj(root, ["commit", "-m", "trunk"]);
      await jj(root, ["bookmark", "create", "main", "-r", "@-"]);
      const forkPoint = (
        await jj(root, ["log", "--no-graph", "-r", "@-", "-T", "commit_id"])
      ).trim();
      await writeFile(path.join(root, "README.md"), "stacked\n", "utf8");
      await jj(root, ["commit", "-m", "stacked change"]);
      const parentChange = (
        await jj(root, ["log", "--no-graph", "-r", "@-", "-T", "commit_id"])
      ).trim();

      const created = await runReviewScaffold({ cwd: root });
      const reviewJson = JSON.parse(
        await readFile(
          path.join(created.reviews[0]!.dir, "review.json"),
          "utf8",
        ),
      );

      expect(reviewJson.baseRef).toBe("main");
      expect(reviewJson.baseCommit).toBe(forkPoint);
      expect(reviewJson.baseCommit).not.toBe(parentChange);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to scaffold from a detached HEAD", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-info-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
      await git(root, ["checkout", "--detach"]);
      await expect(runReviewScaffold({ cwd: root })).rejects.toThrow(
        /no branch, bookmark, or change id/,
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to update a review with a positional binding", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-info-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
      const head = await git(root, ["rev-parse", "HEAD"]);
      const canonicalRoot = await git(root, ["rev-parse", "--show-toplevel"]);
      const review = await createReviewDir({
        worktreePath: canonicalRoot,
        baseRef: head,
        baseCommit: head,
        sourceCommit: head,
        sourceIdentity: { kind: "git-branch", name: "HEAD" },
      });

      await expect(
        runReviewScaffold({
          cwd: root,
          update: true,
          reviewUuid: review.review.uuid,
        }),
      ).rejects.toThrow(/Run `review rebind` first/);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bare --update finds the review when the checkout is behind the moved branch", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-info-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
      await git(root, ["checkout", "-b", "feature"]);
      await writeFile(path.join(root, "README.md"), "# Feature\n", "utf8");
      await git(root, ["commit", "-am", "feature"]);
      const created = await runReviewScaffold({
        cwd: root,
        baseRef: "main",
        headRef: "feature",
      });
      const uuid = created.reviews[0]!.uuid;

      // The branch gains a commit; the checkout stays behind on the old tip.
      const oldTip = await git(root, ["rev-parse", "HEAD"]);
      await writeFile(path.join(root, "README.md"), "# Feature 2\n", "utf8");
      await git(root, ["commit", "-am", "feature 2"]);
      const movedTip = await git(root, ["rev-parse", "HEAD"]);
      await git(root, ["checkout", "--detach", oldTip]);

      const updated = await runReviewScaffold({ cwd: root, update: true });
      expect(updated.reviews).toHaveLength(1);
      expect(updated.reviews[0]?.uuid).toBe(uuid);
      const reviewJson = JSON.parse(
        await readFile(
          path.join(updated.reviews[0]!.dir, "review.json"),
          "utf8",
        ),
      );
      expect(reviewJson.sourceCommit).toBe(movedTip);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves the snapshot ref untouched when an update fails on a bad base", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-info-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
      const created = await runReviewScaffold({ cwd: root });
      const uuid = created.reviews[0]!.uuid;
      const refBefore = await git(root, [
        "rev-parse",
        reviewSourceHeadRef(uuid),
      ]);

      await expect(
        runReviewScaffold({
          cwd: root,
          update: true,
          reviewUuid: uuid,
          baseRef: "no-such-ref",
        }),
      ).rejects.toThrow(/does not exist/);
      await expect(
        git(root, ["rev-parse", reviewSourceHeadRef(uuid)]),
      ).resolves.toBe(refBefore);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rebind re-pins the review from the new change immediately", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-info-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
      await git(root, ["checkout", "-b", "feature"]);
      await writeFile(path.join(root, "README.md"), "# Feature\n", "utf8");
      await git(root, ["commit", "-am", "feature"]);
      const created = await runReviewScaffold({
        cwd: root,
        baseRef: "main",
        headRef: "feature",
      });
      await git(root, ["checkout", "main"]);
      await git(root, ["checkout", "-b", "other"]);
      await writeFile(path.join(root, "other.txt"), "other\n", "utf8");
      await git(root, ["add", "."]);
      await git(root, ["commit", "-m", "other"]);
      const otherTip = await git(root, ["rev-parse", "HEAD"]);

      await runReviewRebind({
        cwd: root,
        change: "other",
        reviewUuid: created.reviews[0]!.uuid,
        env: { CODEX_THREAD_ID: "rebind-1" },
        stdout: nullStream(),
      });
      const reviewJson = JSON.parse(
        await readFile(
          path.join(created.reviews[0]!.dir, "review.json"),
          "utf8",
        ),
      );
      expect(reviewJson.sourceIdentity).toEqual({
        kind: "git-branch",
        name: "other",
      });
      expect(reviewJson.sourceCommit).toBe(otherTip);
      expect(reviewJson.sourceSession).toBe("codex:rebind-1-fork");
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails loudly when base and head share no ancestor", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-info-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
      await git(root, ["checkout", "--orphan", "unrelated"]);
      await git(root, ["commit", "--allow-empty", "-m", "orphan root"]);
      await git(root, ["checkout", "main"]);

      await expect(
        runReviewScaffold({
          cwd: root,
          baseRef: "unrelated",
          headRef: "main",
        }),
      ).rejects.toThrow(/No merge base exists/);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates a review when --update finds none", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-info-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
      const created = await runReviewScaffold({ cwd: root, update: true });
      expect(created.reviews).toHaveLength(1);
      expect(created.reviews[0]?.status).toBe("draft");
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("warns when devfast.prepare is not configured", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-info-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
      const created = await runReviewScaffold({ cwd: root });
      expect(created.warnings).toEqual([
        "devfast.prepare is not configured. Configure it (git config devfast.prepare '<command>') and run `review scaffold --update` to prepare pinned worktrees.",
      ]);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("scaffolds without warnings when the pinned head is on another branch", async () => {
    const root = await makeGitRepository();
    await git(root, ["config", "devfast.prepare", "echo ok"]);
    const home = await mkdtemp(path.join(os.tmpdir(), "review-info-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
      const baseCommit = await git(root, ["rev-parse", "HEAD"]);
      await git(root, ["checkout", "-b", "feature"]);
      await writeFile(path.join(root, "README.md"), "# Feature\n", "utf8");
      await git(root, ["commit", "-am", "feature"]);
      const featureCommit = await git(root, ["rev-parse", "HEAD"]);
      await git(root, ["checkout", "main"]);

      const created = await runReviewScaffold({
        cwd: root,
        baseRef: baseCommit,
        headRef: featureCommit,
      });
      expect(created.warnings).toBeUndefined();
      const reviewJson = JSON.parse(
        await readFile(
          path.join(created.reviews[0]!.dir, "review.json"),
          "utf8",
        ),
      );
      expect(reviewJson.sourceCommit).toBe(featureCommit);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("scaffolds a Git-only commit by full SHA in a colocated jj repo", async () => {
    if (!(await commandAvailable("jj"))) return;

    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-info-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
      await jj(root, ["git", "init", "--colocate"]);
      await git(root, ["config", "devfast.prepare", "echo ok"]);
      const baseCommit = await git(root, ["rev-parse", "HEAD"]);
      await writeFile(
        path.join(root, "README.md"),
        "# Git-only head\n",
        "utf8",
      );
      await git(root, ["add", "README.md"]);
      const tree = await git(root, ["write-tree"]);
      const { stdout } = await execFilePromise(
        "git",
        [
          "-C",
          root,
          "commit-tree",
          tree,
          "-p",
          baseCommit,
          "-m",
          "Git-only head",
        ],
        { encoding: "utf8" },
      );
      const headCommit = stdout.trim();

      await expect(
        jj(root, ["log", "--no-graph", "-r", headCommit]),
      ).rejects.toThrow(/./);

      const created = await runReviewScaffold({
        cwd: root,
        baseRef: baseCommit,
        headRef: headCommit,
      });
      const reviewJson = JSON.parse(
        await readFile(
          path.join(created.reviews[0]!.dir, "review.json"),
          "utf8",
        ),
      );
      expect(reviewJson.sourceCommit).toBe(headCommit);
      expect(reviewJson.sourceIdentity).toEqual({
        kind: "git-commit",
        name: headCommit,
      });
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("hides terminal reviews from default info but lists them with --all", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-info-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
      const created = await runReviewScaffold({ cwd: root });
      const reviewJsonPath = path.join(created.reviews[0]!.dir, "review.json");
      const review = JSON.parse(await readFile(reviewJsonPath, "utf8"));
      review.status = "rejected";
      await writeFile(reviewJsonPath, `${JSON.stringify(review, null, 2)}\n`);

      await expect(resolveReviewInfo({ cwd: root })).resolves.toMatchObject({
        reviews: [],
      });
      await expect(
        resolveReviewInfo({ cwd: root, all: true }),
      ).resolves.toMatchObject({
        reviews: [{ status: "rejected" }],
      });
      await expect(
        resolveReviewInfo({
          cwd: path.join(home, "outside-repository"),
          reviewUuid: created.reviews[0]!.uuid,
        }),
      ).resolves.toMatchObject({
        reviews: [{ uuid: created.reviews[0]!.uuid, status: "rejected" }],
      });
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function makeGitRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-info-source-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "review@example.test"]);
  await git(root, ["config", "user.name", "Review Test"]);
  await writeFile(path.join(root, "README.md"), "# Review\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFilePromise("git", ["-C", root, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

function nullStream(): NodeJS.WriteStream {
  return { write: () => true } as unknown as NodeJS.WriteStream;
}

async function jj(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFilePromise("jj", args, {
    cwd: root,
    encoding: "utf8",
  });
  return stdout;
}

async function commandAvailable(command: string): Promise<boolean> {
  try {
    await execFilePromise(command, ["--version"]);
    return true;
  } catch {
    return false;
  }
}
