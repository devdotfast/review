import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";

import { REVIEW_SCHEMA_VERSION } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { collectingWritable } from "./cli-output";
import {
  type ReviewPackageManager,
  discardLegacyReviewHistories,
  migrateReviewManagedCheckouts,
  removeLegacyDesktopCatalog,
  removeLegacyGlobalReviewInstalls,
  removeLegacyReviewSkills,
  runReviewMigration,
} from "./migrate";
import { createReviewDir, sealReviewCandidate } from "./review-home";
import {
  deleteReviewState,
  listPublications,
  readLegacyArtifactImport,
  reviewIdForDir,
  withReviewStateTransaction,
} from "./review-state-db";
import {
  cleanupTempDirs,
  gitRepository,
  tempDir,
  writeLegacyDocument,
} from "./review-test-utils";
import { reviewVcs } from "./review-vcs";
import { auditStoredReviewDocuments } from "./stored-review-document-audit";

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

afterEach(cleanupTempDirs);

describe("review migrate apply", () => {
  it("keeps a migrated terminal colocated presentation and old history through every follow-on phase", async () => {
    const { reviewHome, reviewDir } = await canonicalReview();
    await mkdir(path.join(reviewDir, ".bundle/document"), { recursive: true });
    await writeFile(
      path.join(reviewDir, ".bundle/document/manifest.json"),
      JSON.stringify({ version: 1, routePath: "/", sourcePath: "review.mdx" }),
    );
    await writeFile(
      path.join(reviewDir, ".bundle/document/review-document.js"),
      `import { jsx, createActiveReviewDocument } from "review-doc-runtime";
      export default createActiveReviewDocument({ title: "Exact", filePath: "review.mdx", routePath: "/", modelNames: [], models: {}, Component: () => jsx("h1", { children: "Exact" }) });`,
    );
    const revision = await sealReviewCandidate(
      reviewDir,
      "Legacy current publication",
    );
    const record = JSON.parse(
      await readFile(path.join(reviewDir, "review.json"), "utf8"),
    );
    await writeFile(
      path.join(reviewDir, "review.json"),
      JSON.stringify({
        ...record,
        schemaVersion: 4,
        status: "accepted",
        presentedDocumentRevision: revision,
      }),
    );
    await mkdir(path.join(reviewDir, ".jj/repo"), { recursive: true });
    await writeFile(path.join(reviewDir, ".jj/repo/operation"), "preserve");
    await writeFile(
      path.join(reviewDir, "review.mdx"),
      "{broken unpublished source",
    );
    const cleanup = async () => ({ checked: 0, removed: 0, blockers: [] });
    const io = streams();
    const code = await runReviewMigration({
      homeDir: reviewHome,
      env: { DEV_REVIEW_HOME: reviewHome },
      stdout: io.stdout,
      stderr: io.stderr,
      runtime: {
        removeLegacyDesktopCatalog: cleanup,
        removeLegacyReviewSkills: cleanup,
        removeLegacyGlobalReviewInstalls: cleanup,
      },
    });
    expect(io.err.join("")).not.toContain("blocker:");
    expect(code).toBe(0);
    const current = JSON.parse(
      await readFile(path.join(reviewDir, "review.json"), "utf8"),
    );
    expect(current).toMatchObject({
      schemaVersion: REVIEW_SCHEMA_VERSION,
      status: "accepted",
    });
    // The imported publication keeps the sealed commit's identity, so a link
    // to the Git-era revision still opens the same published version.
    expect(current.presentedDocumentRevision).toBe(revision);
    expect(
      listPublications(reviewDir, "document").map((row) => row.publicationId),
    ).toEqual([revision]);
    expect(await reviewVcs.resolve(reviewDir, revision)).toBe(revision);
    expect(
      await readFile(path.join(reviewDir, ".jj/repo/operation"), "utf8"),
    ).toBe("preserve");
    expect(await readFile(path.join(reviewDir, "review.mdx"), "utf8")).toBe(
      "{broken unpublished source",
    );
  });
  it("does not reparse a failed legacy review or audit unrelated editable sources after sealed conversion", async () => {
    const io = streams();
    const uuid = "3b241101-e2bb-4255-8caf-4136c566a962";
    const managed = vi.fn<typeof migrateReviewManagedCheckouts>(async () => ({
      checked: 0,
      created: 0,
      legacyRemoved: 0,
      blockers: [],
    }));
    const audit = vi.fn<typeof auditStoredReviewDocuments>(async () => ({
      documents: 0,
      issues: [],
    }));
    const cleanup = async () => ({ checked: 0, removed: 0, blockers: [] });
    const code = await runReviewMigration({
      homeDir: "/home/reviewer",
      packageRoot: "/desktop/review",
      env: { DEV_REVIEW_HOME: "/review-home" },
      stdout: io.stdout,
      stderr: io.stderr,
      runtime: {
        migrateStoredReviewData: async (input) => {
          input.onBlocker?.(
            "Exact sealed conversion failed; review preserved.",
          );
          return {
            documents: 1,
            failedReviewUuids: [uuid],
            droppedLegacyPeekReviews: 0,
            droppedReviews: 0,
            droppedComments: 0,
            droppedQuestions: 0,
            legacyCheckoutsRemoved: 0,
            upgradedThreadDatabases: 0,
            importedVersions: 0,
            unavailableVersions: 0,
          };
        },
        migrateReviewManagedCheckouts: managed,
        auditStoredReviewDocuments: audit,
        removeLegacyDesktopCatalog: cleanup,
        removeLegacyReviewSkills: cleanup,
        removeLegacyGlobalReviewInstalls: cleanup,
      },
    });
    expect(code).toBe(1);
    expect(managed).toHaveBeenCalledWith(
      expect.objectContaining({ skipReviewUuids: [uuid] }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        skipReviewUuids: [uuid],
        onlyUnpresented: true,
      }),
    );
    expect(io.out.join("")).toContain("1 blocker");
  });
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
          importedVersions: 4,
          unavailableVersions: 1,
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
    expect(io.out.join("")).toContain("4 published versions imported");
    expect(io.out.join("")).toContain("1 unavailable version recorded");
    expect(io.out.join("")).toContain("0 legacy Git histories discarded");
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
            importedVersions: 0,
            unavailableVersions: 0,
          };
        },
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

describe("legacy history disposal", () => {
  it("discards the private history only for fully imported Reviews", async () => {
    const { reviewHome, reviewDir } = await legacyPublishedReview();
    const io = streams();
    const cleanup = async () => ({ checked: 0, removed: 0, blockers: [] });

    const applied = await runReviewMigration({
      homeDir: reviewHome,
      env: { DEV_REVIEW_HOME: reviewHome },
      stdout: io.stdout,
      stderr: io.stderr,
      runtime: {
        removeLegacyDesktopCatalog: cleanup,
        removeLegacyReviewSkills: cleanup,
        removeLegacyGlobalReviewInstalls: cleanup,
      },
    });

    expect(applied).toBe(0);
    expect(readLegacyArtifactImport(reviewDir)).toMatchObject({
      versions: 1,
      unavailable: 0,
      legacyRemovedAt: null,
    });
    // The default run never touches the private history.
    await expect(readdir(path.join(reviewDir, ".git"))).resolves.toBeDefined();
    await expect(readdir(path.join(reviewDir, ".build"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );

    const discard = streams();
    const discarded = await runReviewMigration({
      homeDir: reviewHome,
      env: { DEV_REVIEW_HOME: reviewHome },
      discardLegacyGit: true,
      stdout: discard.stdout,
      stderr: discard.stderr,
      runtime: {
        removeLegacyDesktopCatalog: cleanup,
        removeLegacyReviewSkills: cleanup,
        removeLegacyGlobalReviewInstalls: cleanup,
      },
    });

    expect(discarded).toBe(0);
    expect(discard.out.join("")).toContain("1 legacy Git history discarded");
    await expect(readdir(path.join(reviewDir, ".git"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readdir(path.join(reviewDir, ".bundle")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(readLegacyArtifactImport(reviewDir)?.legacyRemovedAt).toEqual(
      expect.any(String),
    );
    expect(listPublications(reviewDir, "document")).toHaveLength(1);
  });

  it("keeps and reports a Review whose versions could not all import", async () => {
    const { reviewHome, reviewDir } = await legacyPublishedReview();
    const io = streams();
    const cleanup = async () => ({ checked: 0, removed: 0, blockers: [] });
    await runReviewMigration({
      homeDir: reviewHome,
      env: { DEV_REVIEW_HOME: reviewHome },
      stdout: io.stdout,
      stderr: io.stderr,
      runtime: {
        removeLegacyDesktopCatalog: cleanup,
        removeLegacyReviewSkills: cleanup,
        removeLegacyGlobalReviewInstalls: cleanup,
      },
    });
    markLegacyArtifactImportUnavailable(reviewDir, reviewHome);

    const result = await discardLegacyReviewHistories({ reviewHome });

    expect(result).toMatchObject({ checked: 1, removed: 0 });
    expect(result.blockers[0]).toContain("could not be imported");
    await expect(readdir(path.join(reviewDir, ".git"))).resolves.toBeDefined();
  });
});

describe("obsolete Desktop catalog cleanup", () => {
  it("removes only recognized direct catalog JSON files", async () => {
    const reviewHome = await tempDir("review-migrate-");
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
    const reviewHome = await tempDir("review-migrate-");
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
    const homeDir = await tempDir("review-migrate-");
    const packageRoot = await tempDir("review-migrate-");
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
      packageRoot: await tempDir("review-migrate-"),
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

/** A schema-4 Review whose single published version is a sealed Git commit. */
async function legacyPublishedReview(): Promise<{
  reviewHome: string;
  reviewDir: string;
}> {
  const { reviewHome, reviewDir } = await canonicalReview();
  await writeLegacyDocument(reviewDir);
  const revision = await sealReviewCandidate(
    reviewDir,
    "Review publish candidate",
  );
  const record = JSON.parse(
    await readFile(path.join(reviewDir, "review.json"), "utf8"),
  );
  await writeFile(
    path.join(reviewDir, "review.json"),
    JSON.stringify({
      ...record,
      schemaVersion: 4,
      presentedDocumentRevision: revision,
    }),
  );
  await mkdir(path.join(reviewDir, ".build", revision), { recursive: true });
  return { reviewHome, reviewDir };
}

/** Rewrites the import marker as if one version had failed to convert. */
function markLegacyArtifactImportUnavailable(
  reviewDir: string,
  reviewHome: string,
): void {
  withReviewStateTransaction(reviewHome, (tx) => {
    tx.db
      .prepare(
        "UPDATE legacy_artifact_imports SET unavailable = 1 WHERE review_id = ?",
      )
      .run(reviewIdForDir(reviewDir));
  });
}

async function canonicalReview(): Promise<{
  reviewHome: string;
  reviewDir: string;
}> {
  const reviewHome = await tempDir("review-migrate-");
  const sourceRoot = await gitRepository();
  const created = await createReviewDir({
    reviewsHomePath: reviewHome,
    worktreePath: sourceRoot,
    baseRef: "HEAD",
    baseCommit: execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
  });
  // Callers overwrite review.json directly to simulate a legacy presentation;
  // drop the draft row createReviewDir wrote so reads fall back to the file.
  deleteReviewState(created.dir);
  return { reviewHome, reviewDir: created.dir };
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
