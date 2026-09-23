import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionInputError } from "./document.js";
import { openLocalSessionStore } from "./local-data.js";
import {
  type PullRequestDeps,
  type PullRequestRecord,
  defaultPullRequestDeps,
  readPullRequest,
} from "./pull-request.js";

const url = "https://github.com/acme/widget/pull/7";

const hasJj = spawnSync("jj", ["--version"]).status === 0;

const command = <Operation>(operation: Operation) => ({
  commandId: randomUUID(),
  operation,
});

describe("reading a pull request", () => {
  const record = {
    number: 7,
    title: "Add widgets",
    baseRefName: "main",
    baseRefOid: "a".repeat(40),
  };

  const deps = (
    gh: () => Promise<string>,
    api?: () => Promise<Response>,
  ): PullRequestDeps & { calls: string[][] } => {
    const calls: string[][] = [];

    return {
      calls,
      run: async (file, args) => {
        calls.push([file, ...args]);

        return gh();
      },
      fetch: vi.fn<typeof fetch>(async (input) => {
        calls.push(["fetch", String(input)]);

        if (!api) throw new Error("unexpected API call");

        return api();
      }),
    };
  };

  const ghFails = () => Promise.reject(new Error("gh pr: not logged in"));

  it("asks gh about the URL's repository and number", async () => {
    const using = deps(async () => JSON.stringify(record));

    await expect(readPullRequest(url, using)).resolves.toEqual({
      slug: "acme/widget",
      ...record,
    });
    expect(using.calls).toEqual([
      [
        "gh",
        "pr",
        "view",
        "7",
        "--repo",
        "acme/widget",
        "--json",
        "number,title,baseRefName,baseRefOid",
      ],
    ]);
  });

  it("falls back to the public API when gh fails", async () => {
    const using = deps(ghFails, async () =>
      Response.json({
        number: 7,
        title: "Add widgets",
        base: { ref: "main", sha: record.baseRefOid },
      }),
    );

    await expect(readPullRequest(url, using)).resolves.toEqual({
      slug: "acme/widget",
      ...record,
    });
    expect(using.calls.at(-1)).toEqual([
      "fetch",
      "https://api.github.com/repos/acme/widget/pulls/7",
    ]);
  });

  it("says a missing or private PR was not found, with gh's reason", async () => {
    const error = await readPullRequest(
      url,
      deps(ghFails, async () => new Response("{}", { status: 404 })),
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(SessionInputError);
    expect(error).toMatchObject({ status: 404 });
    expect(String(error)).toMatch(/not found.*gh auth status.*not logged in/);
  });

  it("names an exhausted rate limit", async () => {
    await expect(
      readPullRequest(
        url,
        deps(
          ghFails,
          async () =>
            new Response("{}", {
              status: 403,
              headers: { "x-ratelimit-remaining": "0" },
            }),
        ),
      ),
    ).rejects.toThrow(/rate limit is exhausted.*gh auth status/);
  });
});

describe("creating a review from a pull request URL alone", () => {
  let directory: string, upstream: string, checkout: string;
  let local: ReturnType<typeof openLocalSessionStore>;

  /** What gh reports; the tests move the base as GitHub would. */
  let pr: Omit<PullRequestRecord, "slug">;

  let ghCalls: number;

  const gitIn =
    (cwd: string) =>
    (...args: string[]) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
        cwd,
        encoding: "utf8",
      }).trim();

  const commit = (cwd: string, file: string, text: string) => {
    writeFileSync(path.join(cwd, file), text);
    gitIn(cwd)("add", ".");
    gitIn(cwd)("commit", "-qm", `Write ${file}`);

    return gitIn(cwd)("rev-parse", "HEAD");
  };

  /** A local repository stands in for github.com/acme/widget. */
  const pointAtUpstream = (gitDir: string) => {
    const config = (...args: string[]) =>
      execFileSync("git", ["--git-dir", gitDir, "config", ...args]);

    config("remote.origin.url", "https://github.com/acme/widget.git");
    config(`url.${upstream}.insteadOf`, "https://github.com/acme/widget.git");
  };

  let fork: string, trunk: string;

  beforeEach(async () => {
    directory = mkdtempSync(path.join(tmpdir(), "whiteboard-pr-create-"));
    upstream = path.join(directory, "upstream");
    mkdirSync(upstream);
    const up = gitIn(upstream);
    up("init", "-q", "-b", "main");
    up("config", "user.name", "Whiteboard Test");
    up("config", "user.email", "whiteboard-test@example.invalid");
    fork = commit(upstream, "base.ts", "export const base = 1;\n");
    // The PR comes from a fork: GitHub exposes it only as refs/pull/7/head.
    up("checkout", "-q", "-b", "contributor");
    commit(upstream, "feature.ts", "export const feature = 1;\n");
    up("update-ref", "refs/pull/7/head", "HEAD");
    up("checkout", "-q", "main");
    up("branch", "-qD", "contributor");
    trunk = commit(upstream, "base.ts", "export const base = 2;\n");

    checkout = path.join(directory, "checkout");
    gitIn(directory)("clone", "-q", upstream, checkout);
    pointAtUpstream(path.join(checkout, ".git"));

    pr = { number: 7, title: "Add widgets", baseRefName: "main" };
    ghCalls = 0;
    local = openLocalSessionStore(path.join(directory, "reviews.db"), {
      manageWorkspaces: false,
      pullRequests: {
        ...defaultPullRequestDeps,
        run: async (file, args, options) => {
          if (file !== "gh")
            return defaultPullRequestDeps.run(file, args, options);
          ghCalls++;

          return JSON.stringify(pr);
        },
        fetch: () => Promise.reject(new Error("no network in tests")),
      },
    });
  });

  afterEach(async () => {
    await local.store.close();
    await local.data.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const createFromUrl = (
    fields: {
      title?: string;
      target?: { kind: "commits"; repositoryId: string; head: string };
    } = {},
  ) =>
    local.store.execute(
      command({ type: "create", pullRequestUrl: url, ...fields }),
    );

  const upstreamHead = () => gitIn(upstream)("rev-parse", "refs/pull/7/head");

  const userRefs = (gitDir: string) =>
    execFileSync(
      "git",
      [
        "--git-dir",
        gitDir,
        "for-each-ref",
        "refs/heads",
        "refs/remotes",
        "refs/tags",
      ],
      { encoding: "utf8" },
    );

  it("fetches a fork PR and pins GitHub's comparison, titled from the PR", async () => {
    const { id: repositoryId } = await local.data.register(checkout);
    const before = userRefs(path.join(checkout, ".git"));

    const created = await createFromUrl();
    const snapshot = local.store.read(created.sessionId);

    expect(created).toMatchObject({ created: true });
    expect(snapshot).toMatchObject({
      title: "Add widgets",
      pins: { repositoryId, base: fork, head: upstreamHead() },
      target: {
        kind: "commits",
        repositoryId,
        base: fork,
        head: upstreamHead(),
      },
      origin: { pullRequestUrl: url, pullRequestNumber: 7 },
    });
    expect(await local.data.changes(snapshot.pins!, "feature.ts")).toContain(
      "+export const feature = 1;",
    );
    expect(userRefs(path.join(checkout, ".git"))).toBe(before);
  });

  it("returns the existing review for a repeat, comparing against the PR's current head", async () => {
    await local.data.register(checkout);
    const first = command({ type: "create", pullRequestUrl: url });
    const created = await local.store.execute(first);

    expect(await createFromUrl()).toMatchObject({
      created: false,
      sessionId: created.sessionId,
      headMoved: false,
    });

    gitIn(upstream)("checkout", "-q", "refs/pull/7/head");
    commit(upstream, "feature.ts", "export const feature = 2;\n");
    gitIn(upstream)("update-ref", "refs/pull/7/head", "HEAD");
    const calls = ghCalls;

    expect(await createFromUrl()).toMatchObject({
      created: false,
      sessionId: created.sessionId,
      headMoved: true,
    });
    // A retry of the first command replays its answer without asking GitHub.
    expect(await local.store.execute(first)).toEqual(created);
    expect(ghCalls).toBe(calls + 1);
  });

  it("diffs a merge-committed PR from GitHub's frozen base, not the absorbing branch", async () => {
    await local.data.register(checkout);
    gitIn(upstream)(
      "merge",
      "-q",
      "--no-ff",
      "refs/pull/7/head",
      "-m",
      "Merge",
    );
    pr.baseRefOid = trunk;

    const { sessionId } = await createFromUrl();

    expect(local.store.read(sessionId).pins).toMatchObject({
      base: fork,
      head: upstreamHead(),
    });
  });

  it("fetches the frozen base when the base branch is gone", async () => {
    await local.data.register(checkout);
    gitIn(upstream)("checkout", "-q", "-b", "release");
    const release = commit(upstream, "release.ts", "export const r = 1;\n");
    gitIn(upstream)("checkout", "-q", "main");
    gitIn(upstream)("branch", "-qD", "release");
    Object.assign(pr, { baseRefName: "release", baseRefOid: release });

    const { sessionId } = await createFromUrl();

    expect(local.store.read(sessionId).pins).toMatchObject({
      base: fork,
      head: upstreamHead(),
    });
  });

  it("asks for a registered checkout of the PR's repository", async () => {
    const other = path.join(directory, "other");
    gitIn(directory)("init", "-q", other);
    gitIn(other)(
      "remote",
      "add",
      "origin",
      "https://github.com/acme/other.git",
    );
    await local.data.register(other);

    await expect(createFromUrl()).rejects.toThrow(
      /Register a checkout of acme\/widget/,
    );
    expect(local.store.list()).toEqual([]);
  });

  it("uses an explicit target instead of asking GitHub", async () => {
    const { id: repositoryId } = await local.data.register(checkout);
    const head = gitIn(checkout)("rev-parse", "HEAD");

    const { sessionId } = await createFromUrl({
      title: "Mine",
      target: { kind: "commits", repositoryId, head },
    });

    expect(ghCalls).toBe(0);
    expect(local.store.read(sessionId)).toMatchObject({
      title: "Mine",
      pins: { base: head, head },
    });
  });

  it.skipIf(!hasJj)(
    "indexes the PR commits in a non-colocated jj repository without leaving a tag",
    async () => {
      const jjRepo = path.join(directory, "jj");
      execFileSync("jj", ["git", "init", "--no-colocate", jjRepo], {
        stdio: "pipe",
      });

      const jj = (...args: string[]) =>
        execFileSync("jj", ["-R", jjRepo, "--ignore-working-copy", ...args], {
          encoding: "utf8",
        }).trim();

      pointAtUpstream(jj("git", "root"));
      const { id: repositoryId } = await local.data.register(jjRepo);

      const { sessionId } = await createFromUrl();

      const pins = local.store.read(sessionId).pins!;
      expect(pins).toMatchObject({
        repositoryId,
        base: fork,
        head: upstreamHead(),
      });
      expect(jj("log", "--no-graph", "-r", pins.head, "-T", "commit_id")).toBe(
        pins.head,
      );
      expect(jj("tag", "list")).toBe("");
      expect(jj("bookmark", "list", "--all-remotes")).toBe("");
      expect(await local.data.changes(pins, "feature.ts")).toContain(
        "+export const feature = 1;",
      );
    },
  );
});
