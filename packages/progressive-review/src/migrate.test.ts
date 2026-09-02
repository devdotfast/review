import { execFileSync } from "node:child_process";
import fs from "node:fs";
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
import type { Writable } from "node:stream";

import * as git from "isomorphic-git";
import { afterEach, describe, expect, it, vi } from "vitest";

import { collectingWritable } from "./cli-output";
import {
  type ReviewPackageManager,
  migrateJjReviewRepositories,
  removeLegacyDesktopCatalog,
  removeLegacyGlobalReviewInstalls,
  removeLegacyReviewSkills,
  runReviewMigration,
} from "./migrate";
import { createReviewDir } from "./review-home";

const tempRoots: string[] = [];
type TestRunCommand = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;
type TestRunProcess = (input: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  stdout: Writable;
  stderr: Writable;
}) => Promise<number>;

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("review migrate apply", () => {
  it("reports every completed phase and returns nonzero for blockers", async () => {
    const io = streams();
    const code = await runReviewMigration({
      homeDir: "/home/reviewer",
      packageRoot: "/desktop/review",
      env: { DEV_REVIEW_HOME: "/review-home" },
      stdout: io.stdout,
      stderr: io.stderr,
      runtime: {
        migrateStoredReviewData: async () => ({
          documents: 3,
          droppedLegacyPeekReviews: 0,
          droppedReviews: 1,
          droppedComments: 2,
          droppedQuestions: 1,
          legacyCheckoutsRemoved: 0,
          upgradedThreadDatabases: 1,
        }),
        migrateJjReviewRepositories: async () => ({
          checked: 1,
          migrated: 1,
          blockers: [],
        }),
        auditStoredReviewDocuments: async () => ({
          documents: 3,
          issues: [],
        }),
        removeLegacyDesktopCatalog: async () => ({
          checked: 2,
          removed: 2,
          blockers: [],
        }),
        removeLegacyReviewSkills: async () => ({
          checked: 2,
          removed: 2,
          blockers: [],
        }),
        removeLegacyGlobalReviewInstalls: async () => ({
          checked: 1,
          removed: 0,
          blockers: ["Desktop-managed review command is missing."],
        }),
      },
    });

    expect(code).toBe(1);
    expect(io.out.join("")).toContain("1 old Review dropped");
    expect(io.out.join("")).toContain("1 jj repository converted");
    expect(io.out.join("")).toContain("1 thread database upgraded");
    expect(io.out.join("")).toContain("3 state records migrated or dropped");
    expect(io.out.join("")).toContain("1 blocker");
    expect(io.err.join("")).toContain(
      "Desktop-managed review command is missing",
    );
  });

  it("continues independent cleanup phases after a migration blocker", async () => {
    const io = streams();
    const catalogCleanup = vi.fn<
      () => Promise<{ checked: number; removed: number; blockers: string[] }>
    >(async () => ({
      checked: 1,
      removed: 1,
      blockers: [],
    }));

    const code = await runReviewMigration({
      homeDir: "/home/reviewer",
      packageRoot: "/desktop/review",
      env: { DEV_REVIEW_HOME: "/review-home" },
      stdout: io.stdout,
      stderr: io.stderr,
      runtime: {
        migrateStoredReviewData: async () => {
          throw new Error("missing session.json");
        },
        migrateJjReviewRepositories: async () => ({
          checked: 0,
          migrated: 0,
          blockers: [],
        }),
        auditStoredReviewDocuments: async () => ({
          documents: 0,
          issues: [],
        }),
        removeLegacyDesktopCatalog: catalogCleanup,
        removeLegacyReviewSkills: async () => ({
          checked: 0,
          removed: 0,
          blockers: [],
        }),
        removeLegacyGlobalReviewInstalls: async () => ({
          checked: 0,
          removed: 0,
          blockers: [],
        }),
      },
    });

    expect(code).toBe(1);
    expect(catalogCleanup).toHaveBeenCalledOnce();
    expect(io.out.join("")).toContain("1 catalog entry removed");
    expect(io.err.join("")).toContain(
      "Old Review cleanup failed: missing session.json",
    );
  });

  it("reports per-Review blockers without aborting the stored-data phase", async () => {
    const io = streams();
    const code = await runReviewMigration({
      homeDir: "/home/reviewer",
      packageRoot: "/desktop/review",
      env: { DEV_REVIEW_HOME: "/review-home" },
      stdout: io.stdout,
      stderr: io.stderr,
      runtime: {
        migrateStoredReviewData: async (input) => {
          input.onBlocker?.("one legacy Review could not migrate");
          return {
            documents: 2,
            droppedLegacyPeekReviews: 0,
            droppedReviews: 1,
            droppedComments: 0,
            droppedQuestions: 0,
            legacyCheckoutsRemoved: 0,
            upgradedThreadDatabases: 0,
          };
        },
        migrateJjReviewRepositories: async () => ({
          checked: 0,
          migrated: 0,
          blockers: [],
        }),
        auditStoredReviewDocuments: async () => ({
          documents: 2,
          issues: [],
        }),
        removeLegacyDesktopCatalog: async () => ({
          checked: 0,
          removed: 0,
          blockers: [],
        }),
        removeLegacyReviewSkills: async () => ({
          checked: 0,
          removed: 0,
          blockers: [],
        }),
        removeLegacyGlobalReviewInstalls: async () => ({
          checked: 0,
          removed: 0,
          blockers: [],
        }),
      },
    });

    expect(code).toBe(1);
    expect(io.out.join("")).toContain("1 old Review dropped");
    expect(io.err.join("")).toContain(
      "Review migration blocker: one legacy Review could not migrate",
    );
  });
});

describe("jj Review repository migration", () => {
  it("rebuilds a canonical Review as plain Git from its working copy", async () => {
    const { reviewHome, reviewDir } = await canonicalReview();
    await mkdir(path.join(reviewDir, ".jj", "repo"), { recursive: true });
    await writeFile(
      path.join(reviewDir, ".jj", "repo", "operation"),
      "legacy jj state\n",
    );
    await writeFile(path.join(reviewDir, "review.mdx"), "# Working copy\n");

    const result = await migrateJjReviewRepositories({ reviewHome });

    expect(result).toEqual({ checked: 1, migrated: 1, blockers: [] });
    await expect(readdir(path.join(reviewDir, ".jj"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(path.join(reviewDir, "review.mdx"), "utf8")).toBe(
      "# Working copy\n",
    );
    expect(
      JSON.parse(await readFile(path.join(reviewDir, "review.json"), "utf8")),
    ).toMatchObject({
      presentedDocumentRevision: null,
      presentedSoftwareMapRevision: null,
    });
    expect(
      await git.currentBranch({ fs, dir: reviewDir, fullname: true }),
    ).toBe("refs/heads/main");
    expect(await git.listFiles({ fs, dir: reviewDir })).not.toContain(
      ".jj/repo/operation",
    );
  });

  it("uses --force to recover a missing colocated Git repository", async () => {
    const { reviewHome, reviewDir } = await canonicalReview();
    await mkdir(path.join(reviewDir, ".jj"), { recursive: true });
    await rm(path.join(reviewDir, ".git"), { recursive: true, force: true });

    await expect(
      migrateJjReviewRepositories({ reviewHome }),
    ).resolves.toMatchObject({
      migrated: 0,
      blockers: [expect.stringContaining(".git directory is missing")],
    });
    await expect(
      migrateJjReviewRepositories({ reviewHome, force: true }),
    ).resolves.toEqual({ checked: 1, migrated: 1, blockers: [] });
  });
});

describe("obsolete Desktop catalog cleanup", () => {
  it("removes only recognized direct catalog JSON files", async () => {
    const reviewHome = await tempDir();
    const desktopRoot = path.join(reviewHome, "review-desktop");
    const catalog = path.join(desktopRoot, "reviews");
    const key = "0123456789abcdef0123456789abcdef";
    await mkdir(path.join(catalog, "nested"), { recursive: true });
    await mkdir(path.join(desktopRoot, "state"), { recursive: true });
    await writeFile(
      path.join(catalog, `${key}.json`),
      `${JSON.stringify({
        reviewKey: key,
        repository: {
          kind: "git",
          repositoryId: "repo",
          repositoryPath: "/repo/.git",
          worktreeRoot: "/repo",
        },
        rootPath: "/repo",
        reviewPath: "/legacy/review.mdx",
        baseRef: "main",
        routePath: "/",
        startedAt: 1,
        updatedAt: 2,
        state: "dismissed",
        available: true,
      })}\n`,
    );
    await writeFile(path.join(catalog, "notes.txt"), "keep\n");
    await writeFile(path.join(catalog, "nested", "keep.json"), "{}\n");
    await writeFile(path.join(desktopRoot, "server.json"), "{}\n");
    await writeFile(path.join(desktopRoot, "state", "profile.json"), "{}\n");

    await expect(removeLegacyDesktopCatalog({ reviewHome })).resolves.toEqual({
      checked: 1,
      removed: 1,
      blockers: [],
    });
    await expect(
      readFile(path.join(catalog, "notes.txt"), "utf8"),
    ).resolves.toBe("keep\n");
    await expect(
      readFile(path.join(catalog, "nested", "keep.json"), "utf8"),
    ).resolves.toBe("{}\n");
    await expect(
      readFile(path.join(desktopRoot, "server.json"), "utf8"),
    ).resolves.toBe("{}\n");
    await expect(
      readFile(path.join(desktopRoot, "state", "profile.json"), "utf8"),
    ).resolves.toBe("{}\n");
  });

  it("keeps unrecognized JSON for agent review", async () => {
    const reviewHome = await tempDir();
    const catalog = path.join(reviewHome, "review-desktop", "reviews");
    await mkdir(catalog, { recursive: true });
    const unknown = path.join(catalog, "unknown.json");
    await writeFile(unknown, "{}\n");

    const result = await removeLegacyDesktopCatalog({ reviewHome });

    expect(result.removed).toBe(0);
    expect(result.blockers).toEqual([
      expect.stringContaining("unknown catalog file name"),
    ]);
    await expect(readFile(unknown, "utf8")).resolves.toBe("{}\n");
  });
});

describe("legacy skill cleanup", () => {
  it("removes positively identified obsolete skills and keeps ambiguous skills", async () => {
    const homeDir = await tempDir();
    const packageRoot = await tempDir();
    const skillsRoot = path.join(homeDir, ".agents", "skills");
    const legacy = path.join(skillsRoot, "review");
    const ambiguous = path.join(skillsRoot, "review-map");
    const current = path.join(skillsRoot, "dev-review");
    await mkdir(legacy, { recursive: true });
    await mkdir(ambiguous, { recursive: true });
    await mkdir(current, { recursive: true });
    await writeFile(
      path.join(legacy, "SKILL.md"),
      "---\nname: review\ndescription: Old dev.fast Review\n---\n",
    );
    await writeFile(
      path.join(ambiguous, "SKILL.md"),
      "---\nname: review-map\ndescription: Personal map\n---\n",
    );
    await writeFile(
      path.join(current, "SKILL.md"),
      "---\nname: dev-review\ndescription: Personal current skill\n---\n",
    );

    const result = await removeLegacyReviewSkills({ homeDir, packageRoot });

    expect(result.removed).toBe(1);
    expect(result.blockers).toHaveLength(2);
    await expect(readdir(legacy)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(path.join(ambiguous, "SKILL.md"), "utf8"),
    ).resolves.toContain("Personal map");
    await expect(
      readFile(path.join(current, "SKILL.md"), "utf8"),
    ).resolves.toContain("Personal current skill");
  });
});

describe("legacy global CLI cleanup", () => {
  it.each([
    ["npm", ["uninstall", "--global", "@dev.fast/review"]],
    ["pnpm", ["remove", "--global", "@dev.fast/review"]],
    ["yarn", ["global", "remove", "@dev.fast/review"]],
    ["bun", ["remove", "--global", "@dev.fast/review"]],
  ] as const)("uses the owning %s uninstall command", async (manager, args) => {
    const fixture = await globalPackage(manager);
    const runProcess = vi.fn<TestRunProcess>(async () => 0);

    const result = await removeLegacyGlobalReviewInstalls({
      packageRoot: await tempDir(),
      homeDir: fixture.homeDir,
      env: {},
      desktopManagedCli: true,
      stdout: streams().stdout,
      stderr: streams().stderr,
      runCommand: fixture.runCommand,
      runProcess,
    });

    expect(result).toMatchObject({ checked: 1, removed: 1, blockers: [] });
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({ command: manager, args }),
    );
  });

  it("does not remove the only working global CLI", async () => {
    const fixture = await globalPackage("npm");
    const runProcess = vi.fn<TestRunProcess>(async () => 0);

    const result = await removeLegacyGlobalReviewInstalls({
      packageRoot: fixture.packageRoot,
      homeDir: fixture.homeDir,
      env: {},
      desktopManagedCli: false,
      stdout: streams().stdout,
      stderr: streams().stderr,
      runCommand: fixture.runCommand,
      runProcess,
    });

    expect(result.removed).toBe(0);
    expect(result.blockers).toEqual([
      expect.stringContaining("no separate Desktop-managed review command"),
    ]);
    expect(runProcess).not.toHaveBeenCalled();
  });
});

async function canonicalReview(): Promise<{
  reviewHome: string;
  reviewDir: string;
}> {
  const reviewHome = await tempDir();
  const sourceRoot = await gitRepository();
  const created = await createReviewDir({
    reviewsHomePath: reviewHome,
    worktreePath: sourceRoot,
    baseRef: "HEAD",
    baseCommit: execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
  });
  return { reviewHome, reviewDir: created.dir };
}

async function gitRepository(): Promise<string> {
  const root = await tempDir("review-migrate-source-");
  execFileSync("git", ["init", root], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Review Test"]);
  await writeFile(path.join(root, "README.md"), "# Source\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-m", "initial"], {
    stdio: "ignore",
  });
  return root;
}

async function globalPackage(manager: ReviewPackageManager): Promise<{
  homeDir: string;
  packageRoot: string;
  runCommand: TestRunCommand;
}> {
  const root = await tempDir(`review-migrate-${manager}-`);
  const homeDir = path.join(root, "home");
  const managerRoot =
    manager === "yarn"
      ? path.join(root, "yarn", "global")
      : manager === "bun"
        ? path.join(homeDir, ".bun", "install", "global", "node_modules")
        : path.join(root, manager, "global", "node_modules");
  const packageRoot = path.join(
    manager === "yarn" ? path.join(managerRoot, "node_modules") : managerRoot,
    "@dev.fast",
    "review",
  );
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "@dev.fast/review", version: "0.1.0" })}\n`,
  );
  const runCommand = vi.fn<TestRunCommand>(async (command: string) => {
    if (command !== manager) throw new Error(`${command} unavailable`);
    if (manager === "yarn") return { stdout: `${managerRoot}\n`, stderr: "" };
    if (manager === "bun") {
      return {
        stdout: `${path.join(homeDir, ".bun", "bin")}\n`,
        stderr: "",
      };
    }
    return { stdout: `${managerRoot}\n`, stderr: "" };
  });
  return { homeDir, packageRoot, runCommand };
}

async function tempDir(prefix = "review-migrate-"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function streams() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: collectingWritable(out),
    stderr: collectingWritable(err),
  };
}
