import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REVIEW_SCHEMA_VERSION } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProgressiveReviewTelemetry } from "../progressive-review-telemetry";
import { createReviewDir } from "../review-home";
import { writePrivateJsonAtomic } from "./desktop-paths";
import { createGlobalReviewServer } from "./desktop-server";
import type {
  ReviewSessionHandler,
  ReviewSessionHandlerInput,
} from "./session-handler";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const token = "build-prune-test-token";
const TEST_REVIEW_UUID = "00000000-0000-4000-8000-00000000bbbb";

const R1 = "1".repeat(40);
const R2 = "2".repeat(40);
const R3 = "3".repeat(40);
const S0 = "a".repeat(40);
const S1 = "b".repeat(40);
const S2 = "c".repeat(40);
const S3 = "d".repeat(40);
const S4 = "e".repeat(40);

// Pre-created build mtime ordering (seconds since epoch). Only the relative
// order matters: outdated builds are reclaimed by the `previous` slot, so the
// newest obsolete build must out-race a live session's pinned build when the
// live session's revision is not protected.
const MTIME = new Map<string, number>([
  [S0, 1000],
  [R1, 2000],
  [S1, 3000],
  [R2, 4000],
  [S2, 5000],
]);

interface Context {
  home: string;
  server: ReturnType<typeof createGlobalReviewServer>;
  handlers: ReviewSessionHandlerInput[];
  buildsPath: string;
  exists: (revision: string) => boolean;
  publishMap: (revision: string) => Promise<void>;
  publishDoc: (revision: string) => Promise<void>;
  close: () => Promise<void>;
}

afterEach(() => vi.unstubAllEnvs());

describe("pruneReviewBuilds across republish", () => {
  it("keeps a historical session's pinned builds across software-map republish", async () => {
    const ctx = await setup();
    try {
      await openHistoricalSession(ctx, R1);

      await expect(ctx.publishMap(S3)).resolves.toBeUndefined();
      await expect(ctx.publishMap(S4)).resolves.toBeUndefined();

      // The historical session pinned .build/R1 (document) and .build/S1
      // (software map read from <R1>/review.json). Both must survive every
      // subsequent content-changing map republish.
      expect(ctx.exists(R1)).toBe(true);
      expect(ctx.exists(S1)).toBe(true);
      // The currently promoted document and the freshly promoted maps survive.
      expect(ctx.exists(R2)).toBe(true);
      expect(ctx.exists(S3)).toBe(true);
      expect(ctx.exists(S4)).toBe(true);
      // Obsolete builds that no live session pins are still reclaimed: S0 at
      // the first republish, S2 at the second (kept as `previous` once, then
      // superseded by S3).
      expect(ctx.exists(S0)).toBe(false);
      expect(ctx.exists(S2)).toBe(false);
      // The historical session captured the older map build (.build/S1) even
      // though the working-store presentedSoftwareMapRevision had already
      // advanced when it opened: the fix must protect the captured on-disk path,
      // not the now-stale working-store pointer.
      const historical = ctx.handlers[0];
      expect(historical?.historicalRevision).toBe(R1);
      expect(path.basename(historical?.softwareMapRootPath ?? "")).toBe(S1);
    } finally {
      await ctx.close();
    }
  });

  it("keeps a historical session's pinned builds across document republish", async () => {
    const ctx = await setup();
    try {
      await openHistoricalSession(ctx, R1);

      await expect(ctx.publishDoc(R3)).resolves.toBeUndefined();

      expect(ctx.exists(R1)).toBe(true);
      expect(ctx.exists(S1)).toBe(true);
      expect(ctx.exists(R3)).toBe(true);
      // The working software-map revision the republished document carries is
      // protected (it is the successor session's softwareMapRootPath).
      expect(ctx.exists(S2)).toBe(true);
      // An obsolete build no live session pins is still reclaimed.
      expect(ctx.exists(S0)).toBe(false);
    } finally {
      await ctx.close();
    }
  });
});

async function setup(): Promise<Context> {
  const home = await mkdtemp(path.join(os.tmpdir(), "review-build-prune-"));
  vi.stubEnv("DEV_REVIEW_HOME", home);

  const worktreePath = await createGitWorktree(home);
  const { headCommit, baseCommit } = readWorktreeCommits(worktreePath);

  const created = await createReviewDir({
    uuid: TEST_REVIEW_UUID,
    reviewsHomePath: home,
    worktreePath,
    baseRef: "main",
    baseCommit,
    sourceCommit: headCommit,
    sourceIdentity: { kind: "git-branch", name: "feature" },
    title: "Build prune test",
    sourceSession: "disabled:review",
  });
  // Working store: the document R2 is the current promoted document revision,
  // and S2 is the current promoted software-map revision. The historical
  // session below is opened on R1 (a sealed document revision whose review.json
  // pins the older software map S1).
  await writePrivateJsonAtomic(path.join(created.dir, "review.json"), {
    ...created.review,
    status: "awaiting-review",
    sourceCommit: headCommit,
    baseCommit,
    presentedDocumentRevision: R2,
    presentedSoftwareMapRevision: S2,
    lastPublishedAt: "2026-01-01T00:00:00.000Z",
  });

  const buildsPath = path.join(created.dir, ".build");
  const repoKey = created.review.repoKey;
  await writeBuild(buildsPath, R1, {
    repoKey,
    worktreePath,
    head: headCommit,
    base: baseCommit,
    presentedDocumentRevision: R1,
    presentedSoftwareMapRevision: S1,
  });
  await writeBuild(buildsPath, R2, {
    repoKey,
    worktreePath,
    head: headCommit,
    base: baseCommit,
    presentedDocumentRevision: R2,
    presentedSoftwareMapRevision: S2,
  });
  for (const mapRevision of [S0, S1, S2]) {
    await writeBuild(buildsPath, mapRevision, {
      repoKey,
      worktreePath,
      head: headCommit,
      base: baseCommit,
      presentedDocumentRevision: R2,
      presentedSoftwareMapRevision: null,
    });
  }
  for (const revision of [S0, R1, S1, R2, S2]) {
    const mtime = MTIME.get(revision);
    if (mtime === undefined) throw new Error(`missing mtime for ${revision}`);
    await utimes(path.join(buildsPath, revision), mtime, mtime);
  }

  const handlers: ReviewSessionHandlerInput[] = [];
  const server = createGlobalReviewServer({
    appPid: process.pid,
    packageRoot,
    toolingRoot: packageRoot,
    port: 0,
    token,
    discoveryPath: path.join(home, "desktop.json"),
    telemetry: new ProgressiveReviewTelemetry({
      captureClient: { enabled: false, capture: async () => {} },
    }),
    sessionHandlerFactory: async (input) => {
      handlers.push(input);
      return stubHandler();
    },
    publishRuntime: {
      materializePublishRevision: async (input) => {
        const buildDir = path.join(input.review.dir, ".build", input.revision);
        if (existsSync(buildDir)) return buildDir;
        await writeBuild(buildsPath, input.revision, {
          repoKey,
          worktreePath,
          head: headCommit,
          base: baseCommit,
          presentedDocumentRevision: input.revision,
          presentedSoftwareMapRevision: null,
        });
        return buildDir;
      },
    },
  });

  await server.listen();
  const relay = await attachControlRelay(server.url, token);

  const exists = (revision: string) =>
    existsSync(path.join(buildsPath, revision));

  const publishMap = async (revision: string) => {
    const response = await fetch(`${server.url}/map-publish-ready`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-review-token": token },
      body: JSON.stringify({ reviewUuid: TEST_REVIEW_UUID, revision }),
    });
    if (!response.ok) {
      throw new Error(
        `map publish ${revision} failed: ${response.status} ${await response.text()}`,
      );
    }
  };
  const publishDoc = async (revision: string) => {
    const response = await fetch(`${server.url}/publish-ready`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-review-token": token },
      body: JSON.stringify({ reviewUuid: TEST_REVIEW_UUID, revision }),
    });
    if (!response.ok) {
      throw new Error(
        `doc publish ${revision} failed: ${response.status} ${await response.text()}`,
      );
    }
  };

  return {
    home,
    server,
    handlers,
    buildsPath,
    exists,
    publishMap,
    publishDoc,
    close: async () => {
      await relay.abort();
      await server.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

async function openHistoricalSession(
  ctx: Context,
  revision: string,
): Promise<void> {
  const response = await fetch(
    `${ctx.server.url}/reviews/${TEST_REVIEW_UUID}/open`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-review-token": token },
      body: JSON.stringify({ revision }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `open historical ${revision} failed: ${response.status} ${await response.text()}`,
    );
  }
}

async function writeBuild(
  buildsPath: string,
  revision: string,
  input: {
    repoKey: string;
    worktreePath: string;
    head: string;
    base: string;
    presentedDocumentRevision: string;
    presentedSoftwareMapRevision: string | null;
  },
): Promise<void> {
  const buildDir = path.join(buildsPath, revision);
  await mkdir(path.join(buildDir, ".bundle", "software-map"), {
    recursive: true,
    mode: 0o700,
  });
  const record = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    uuid: TEST_REVIEW_UUID,
    repoKey: input.repoKey,
    worktreePath: input.worktreePath,
    baseRef: "main",
    baseCommit: input.base,
    sourceCommit: input.head,
    sourceIdentity: { kind: "git-branch" as const, name: "feature" },
    title: "Build prune test",
    sourceSession: "disabled:review",
    status: "awaiting-review",
    presentedDocumentRevision: input.presentedDocumentRevision,
    presentedSoftwareMapRevision: input.presentedSoftwareMapRevision,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastPublishedAt: "2026-01-01T00:00:00.000Z",
  };
  const manifest = {
    version: 1,
    headCommit: input.head,
    baseCommit: input.base,
  };
  await Promise.all([
    writeFile(
      path.join(buildDir, "review.json"),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      path.join(buildDir, "review.mdx"),
      `# Doc ${revision}\n\nbody\n`,
      "utf8",
    ),
    writeFile(
      path.join(buildDir, ".bundle", "software-map", "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      path.join(buildDir, ".bundle", "software-map", "head-map.js"),
      "export default Object.freeze({ elements: [], relationships: [] });\n",
      "utf8",
    ),
    writeFile(
      path.join(buildDir, ".bundle", "software-map", "base-map.js"),
      "export default Object.freeze({ elements: [], relationships: [] });\n",
      "utf8",
    ),
  ]);
}

interface ControlRelay {
  abort: () => Promise<void>;
}

async function attachControlRelay(
  serverUrl: string,
  token: string,
): Promise<ControlRelay> {
  const response = await fetch(`${serverUrl}/control`, {
    headers: { "x-review-token": token },
  });
  if (response.status !== 200 || !response.body) {
    throw new Error(`control attach failed: ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of event.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const payload = JSON.parse(line.slice(6)) as {
            event: string;
            id: string;
            sessionId: string;
          };
          if (payload.event !== "desktop-verb") continue;
          await fetch(`${serverUrl}/control/result`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-review-token": token,
            },
            body: JSON.stringify({
              id: payload.id,
              sessionId: payload.sessionId,
              response: { ok: true },
            }),
          });
        }
      }
    }
  })().catch(() => {});

  // Wait until the relay has actually attached before any publish runs.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const health = await fetch(`${serverUrl}/health`, {
      headers: { "x-review-token": token },
    });
    const body = (await health.json()) as { desktopAttached?: boolean };
    if (body.desktopAttached) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return {
    abort: async () => {
      await reader.cancel().catch(() => undefined);
    },
  };
}

function stubHandler(): ReviewSessionHandler {
  return {
    token,
    handle: async () => new Response("not found", { status: 404 }),
    close: async () => undefined,
  };
}

function createGitWorktree(home: string): string {
  const rootPath = path.join(home, "worktree");
  execFileSync("git", ["init", rootPath], { stdio: "ignore" });
  runGit(rootPath, ["config", "user.email", "review@example.com"]);
  runGit(rootPath, ["config", "user.name", "Review Test"]);
  runGit(rootPath, ["config", "commit.gpgsign", "false"]);
  return rootPath;
}

function readWorktreeCommits(rootPath: string) {
  // A base commit, then a head commit on a feature branch off main.
  writeFileSync(`${rootPath}/README.md`, "base\n");
  runGit(rootPath, ["add", "README.md"]);
  runGit(rootPath, ["commit", "-m", "base"]);
  runGit(rootPath, ["branch", "-M", "main"]);
  runGit(rootPath, ["checkout", "-b", "feature"]);
  writeFileSync(`${rootPath}/README.md`, "head\n");
  runGit(rootPath, ["add", "README.md"]);
  runGit(rootPath, ["commit", "-m", "head"]);
  const headCommit = runGitOutput(rootPath, ["rev-parse", "HEAD"]);
  runGit(rootPath, ["checkout", "main"]);
  const baseCommit = runGitOutput(rootPath, ["rev-parse", "HEAD"]);
  return { headCommit, baseCommit };
}

function runGit(rootPath: string, args: string[]): void {
  execFileSync("git", args, { cwd: rootPath, stdio: "ignore" });
}

function runGitOutput(rootPath: string, args: string[]): string {
  return execFileSync("git", args, { cwd: rootPath, encoding: "utf8" }).trim();
}
