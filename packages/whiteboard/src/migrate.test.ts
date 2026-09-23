import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";

import { collectingWritable } from "@dev.fast/trace-core";
import * as git from "isomorphic-git";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type WhiteboardPackageManager,
  migrateJjWhiteboardRepositories,
  migrateWhiteboardManagedCheckouts,
  removeLegacyDesktopCatalog,
  removeLegacyGlobalWhiteboardInstalls,
  removeLegacyWhiteboardSkills,
  runWhiteboardMigration,
} from "./migrate";
import {
  createWhiteboardDir,
  sealWhiteboardCandidate,
} from "./whiteboard-home";
import {
  cleanupTempDirs,
  gitRepository,
  tempDir,
} from "./whiteboard-test-utils";

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
  it("leaves retired draft MDX untouched without reporting authoring blockers", async () => {
    const { whiteboardHome, whiteboardDir } = await canonicalWhiteboard();

    const source =
      'import type { AnchorRef } from "@dev.fast/review/authoring";\n';

    const documentPath = path.join(whiteboardDir, "review.mdx");

    await writeFile(documentPath, source);
    const io = streams();
    const cleanup = async () => ({ checked: 0, removed: 0, blockers: [] });

    const code = await runWhiteboardMigration({
      homeDir: whiteboardHome,
      env: { DEV_WHITEBOARD_HOME: whiteboardHome },
      json: true,
      stdout: io.stdout,
      stderr: io.stderr,
      runtime: {
        removeLegacyDesktopCatalog: cleanup,
        removeLegacyWhiteboardSkills: cleanup,
        removeLegacyGlobalWhiteboardInstalls: cleanup,
      },
    });

    expect(code).toBe(0);
    expect(await readFile(documentPath, "utf8")).toBe(source);
    expect(JSON.parse(io.out.join(""))).toMatchObject({
      event: "migrated",
      issues: [],
      blockers: [],
    });
  });

  it("keeps a migrated terminal colocated-jj presentation and old history through every follow-on phase", async () => {
    const { whiteboardHome, whiteboardDir } = await canonicalWhiteboard();
    await mkdir(path.join(whiteboardDir, ".bundle/document"), {
      recursive: true,
    });
    await writeFile(
      path.join(whiteboardDir, ".bundle/document/manifest.json"),
      JSON.stringify({ version: 1, routePath: "/", sourcePath: "review.mdx" }),
    );
    await writeFile(
      path.join(whiteboardDir, ".bundle/document/review-document.js"),
      `import { jsx, createActiveWhiteboardDocument } from "review-doc-runtime";
      export default createActiveWhiteboardDocument({ title: "Exact", filePath: "review.mdx", routePath: "/", modelNames: [], models: {}, Component: () => jsx("h1", { children: "Exact" }) });`,
    );

    const revision = await sealWhiteboardCandidate(
      whiteboardDir,
      "Legacy current publication",
    );

    const record = JSON.parse(
      await readFile(path.join(whiteboardDir, "review.json"), "utf8"),
    );

    await writeFile(
      path.join(whiteboardDir, "review.json"),
      JSON.stringify({
        ...record,
        schemaVersion: 4,
        status: "accepted",
        presentedDocumentRevision: revision,
      }),
    );
    await mkdir(path.join(whiteboardDir, ".jj/repo"), { recursive: true });
    await writeFile(path.join(whiteboardDir, ".jj/repo/operation"), "preserve");
    await writeFile(
      path.join(whiteboardDir, "review.mdx"),
      "{broken unpublished source",
    );
    const cleanup = async () => ({ checked: 0, removed: 0, blockers: [] });
    const io = streams();

    const code = await runWhiteboardMigration({
      homeDir: whiteboardHome,
      env: { DEV_WHITEBOARD_HOME: whiteboardHome },
      stdout: io.stdout,
      stderr: io.stderr,
      runtime: {
        removeLegacyDesktopCatalog: cleanup,
        removeLegacyWhiteboardSkills: cleanup,
        removeLegacyGlobalWhiteboardInstalls: cleanup,
      },
    });

    expect(io.err.join("")).not.toContain("blocker:");
    expect(code).toBe(0);

    const current = JSON.parse(
      await readFile(path.join(whiteboardDir, "review.json"), "utf8"),
    );

    expect(current).toMatchObject({ schemaVersion: 5, status: "accepted" });
    expect(current.presentedDocumentRevision).not.toBe(revision);
    expect(current.presentedDocumentRevision).not.toBeNull();
    expect(
      await git.readCommit({ fs, dir: whiteboardDir, oid: revision }),
    ).toBeDefined();
    expect(
      await readFile(path.join(whiteboardDir, ".jj/repo/operation"), "utf8"),
    ).toBe("preserve");
    expect(await readFile(path.join(whiteboardDir, "review.mdx"), "utf8")).toBe(
      "{broken unpublished source",
    );
  });
  it("does not reparse a failed legacy review in subsequent migration phases", async () => {
    const io = streams();
    const uuid = "3b241101-e2bb-4255-8caf-4136c566a962";

    const managed = vi.fn<typeof migrateWhiteboardManagedCheckouts>(
      async () => ({
        checked: 0,
        created: 0,
        legacyRemoved: 0,
        blockers: [],
      }),
    );

    const jj = vi.fn<typeof migrateJjWhiteboardRepositories>(async () => ({
      checked: 0,
      migrated: 0,
      blockers: [],
    }));

    const cleanup = async () => ({ checked: 0, removed: 0, blockers: [] });

    const code = await runWhiteboardMigration({
      homeDir: "/home/reviewer",
      packageRoot: "/desktop/review",
      env: { DEV_WHITEBOARD_HOME: "/whiteboard-home" },
      stdout: io.stdout,
      stderr: io.stderr,
      runtime: {
        migrateStoredWhiteboardData: async (input) => {
          input.onBlocker?.(
            "Exact sealed conversion failed; review preserved.",
          );

          return {
            documents: 1,
            failedWhiteboardUuids: [uuid],
            droppedLegacyPeekWhiteboards: 0,
            droppedWhiteboards: 0,
            legacyCheckoutsRemoved: 0,
          };
        },
        migrateJjWhiteboardRepositories: jj,
        migrateWhiteboardManagedCheckouts: managed,
        removeLegacyDesktopCatalog: cleanup,
        removeLegacyWhiteboardSkills: cleanup,
        removeLegacyGlobalWhiteboardInstalls: cleanup,
      },
    });

    expect(code).toBe(1);
    expect(managed).toHaveBeenCalledWith(
      expect.objectContaining({ skipWhiteboardUuids: [uuid] }),
    );
    expect(jj).toHaveBeenCalledWith(
      expect.objectContaining({ skipWhiteboardUuids: [uuid] }),
    );
    expect(io.out.join("")).toContain("1 blocker");
  });
  it("reports every completed phase and returns nonzero for blockers", async () => {
    const io = streams();

    const code = await runWhiteboardMigration({
      homeDir: "/home/reviewer",
      packageRoot: "/desktop/review",
      env: { DEV_WHITEBOARD_HOME: "/whiteboard-home" },
      stdout: io.stdout,
      stderr: io.stderr,
      runtime: {
        migrateStoredWhiteboardData: async () => ({
          documents: 3,
          droppedLegacyPeekWhiteboards: 0,
          droppedWhiteboards: 1,
          legacyCheckoutsRemoved: 0,
        }),
        migrateJjWhiteboardRepositories: async () => ({
          checked: 1,
          migrated: 1,
          blockers: [],
        }),
        removeLegacyDesktopCatalog: async () => ({
          checked: 2,
          removed: 2,
          blockers: [],
        }),
        removeLegacyWhiteboardSkills: async () => ({
          checked: 2,
          removed: 2,
          blockers: [],
        }),
        removeLegacyGlobalWhiteboardInstalls: async () => ({
          checked: 1,
          removed: 0,
          blockers: ["Desktop-managed review command is missing."],
        }),
      },
    });

    expect(code).toBe(1);
    expect(io.out.join("")).toContain("1 old Review dropped");
    expect(io.out.join("")).toContain("1 jj repository converted");
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

    const code = await runWhiteboardMigration({
      homeDir: "/home/reviewer",
      packageRoot: "/desktop/review",
      env: { DEV_WHITEBOARD_HOME: "/whiteboard-home" },
      stdout: io.stdout,
      stderr: io.stderr,
      runtime: {
        migrateStoredWhiteboardData: async () => {
          throw new Error("missing session.json");
        },
        migrateJjWhiteboardRepositories: async () => ({
          checked: 0,
          migrated: 0,
          blockers: [],
        }),
        removeLegacyDesktopCatalog: catalogCleanup,
        removeLegacyWhiteboardSkills: async () => ({
          checked: 0,
          removed: 0,
          blockers: [],
        }),
        removeLegacyGlobalWhiteboardInstalls: async () => ({
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

    const code = await runWhiteboardMigration({
      homeDir: "/home/reviewer",
      packageRoot: "/desktop/review",
      env: { DEV_WHITEBOARD_HOME: "/whiteboard-home" },
      stdout: io.stdout,
      stderr: io.stderr,
      runtime: {
        migrateStoredWhiteboardData: async (input) => {
          input.onBlocker?.("one legacy Review could not migrate");

          return {
            documents: 2,
            droppedLegacyPeekWhiteboards: 0,
            droppedWhiteboards: 1,
            legacyCheckoutsRemoved: 0,
          };
        },
        migrateJjWhiteboardRepositories: async () => ({
          checked: 0,
          migrated: 0,
          blockers: [],
        }),
        removeLegacyDesktopCatalog: async () => ({
          checked: 0,
          removed: 0,
          blockers: [],
        }),
        removeLegacyWhiteboardSkills: async () => ({
          checked: 0,
          removed: 0,
          blockers: [],
        }),
        removeLegacyGlobalWhiteboardInstalls: async () => ({
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
  it("preserves current pointers and every private historical commit for colocated jj reviews", async () => {
    const { whiteboardHome, whiteboardDir } = await canonicalWhiteboard();

    const revision = await sealWhiteboardCandidate(
      whiteboardDir,
      "Immutable legacy history",
    );

    const record = JSON.parse(
      await readFile(path.join(whiteboardDir, "review.json"), "utf8"),
    );

    const current = JSON.stringify({
      ...record,
      presentedDocumentRevision: revision,
    });

    await writeFile(path.join(whiteboardDir, "review.json"), current);
    await mkdir(path.join(whiteboardDir, ".jj/repo"), { recursive: true });
    await writeFile(
      path.join(whiteboardDir, ".jj/repo/operation"),
      "keep history",
    );
    expect(await migrateJjWhiteboardRepositories({ whiteboardHome })).toEqual({
      checked: 1,
      migrated: 0,
      blockers: [],
    });
    expect(
      await readFile(path.join(whiteboardDir, "review.json"), "utf8"),
    ).toBe(current);
    expect(
      await git.readCommit({ fs, dir: whiteboardDir, oid: revision }),
    ).toBeDefined();
    expect(
      await readFile(path.join(whiteboardDir, ".jj/repo/operation"), "utf8"),
    ).toBe("keep history");
  });
  it("rebuilds a canonical Review as plain Git from its working copy", async () => {
    const { whiteboardHome, whiteboardDir } = await canonicalWhiteboard();
    await mkdir(path.join(whiteboardDir, ".jj", "repo"), { recursive: true });
    await writeFile(
      path.join(whiteboardDir, ".jj", "repo", "operation"),
      "legacy jj state\n",
    );
    await writeFile(path.join(whiteboardDir, "review.mdx"), "# Working copy\n");

    const result = await migrateJjWhiteboardRepositories({ whiteboardHome });

    expect(result).toEqual({ checked: 1, migrated: 1, blockers: [] });
    await expect(
      readdir(path.join(whiteboardDir, ".jj")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(path.join(whiteboardDir, "review.mdx"), "utf8")).toBe(
      "# Working copy\n",
    );
    expect(
      JSON.parse(
        await readFile(path.join(whiteboardDir, "review.json"), "utf8"),
      ),
    ).toMatchObject({
      presentedDocumentRevision: null,
      presentedSoftwareMapRevision: null,
    });
    expect(
      await git.currentBranch({ fs, dir: whiteboardDir, fullname: true }),
    ).toBe("refs/heads/main");
    expect(await git.listFiles({ fs, dir: whiteboardDir })).not.toContain(
      ".jj/repo/operation",
    );
  });

  it("uses --force to recover a missing colocated Git repository", async () => {
    const { whiteboardHome, whiteboardDir } = await canonicalWhiteboard();
    await mkdir(path.join(whiteboardDir, ".jj"), { recursive: true });
    await rm(path.join(whiteboardDir, ".git"), {
      recursive: true,
      force: true,
    });

    await expect(
      migrateJjWhiteboardRepositories({ whiteboardHome }),
    ).resolves.toMatchObject({
      migrated: 0,
      blockers: [expect.stringContaining(".git directory is missing")],
    });
    await expect(
      migrateJjWhiteboardRepositories({ whiteboardHome, force: true }),
    ).resolves.toEqual({ checked: 1, migrated: 1, blockers: [] });
  });
});

describe("obsolete Desktop catalog cleanup", () => {
  it("removes only recognized direct catalog JSON files", async () => {
    const whiteboardHome = await tempDir("review-migrate-");
    const desktopRoot = path.join(whiteboardHome, "review-desktop");
    const catalog = path.join(desktopRoot, "reviews");
    const key = "0123456789abcdef0123456789abcdef";
    await mkdir(path.join(catalog, "nested"), { recursive: true });
    await mkdir(path.join(desktopRoot, "state"), { recursive: true });
    await writeFile(
      path.join(catalog, `${key}.json`),
      `${JSON.stringify({
        whiteboardKey: key,
        repository: {
          kind: "git",
          repositoryId: "repo",
          repositoryPath: "/repo/.git",
          worktreeRoot: "/repo",
        },
        rootPath: "/repo",
        whiteboardPath: "/legacy/review.mdx",
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

    await expect(
      removeLegacyDesktopCatalog({ whiteboardHome }),
    ).resolves.toEqual({
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
    const whiteboardHome = await tempDir("review-migrate-");
    const catalog = path.join(whiteboardHome, "review-desktop", "reviews");
    await mkdir(catalog, { recursive: true });
    const unknown = path.join(catalog, "unknown.json");
    await writeFile(unknown, "{}\n");

    const result = await removeLegacyDesktopCatalog({ whiteboardHome });

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

    const result = await removeLegacyWhiteboardSkills({ homeDir, packageRoot });

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

    const result = await removeLegacyGlobalWhiteboardInstalls({
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

    const result = await removeLegacyGlobalWhiteboardInstalls({
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

async function canonicalWhiteboard(): Promise<{
  whiteboardHome: string;
  whiteboardDir: string;
}> {
  const whiteboardHome = await tempDir("review-migrate-");
  const sourceRoot = await gitRepository();

  const created = await createWhiteboardDir({
    reviewsHomePath: whiteboardHome,
    worktreePath: sourceRoot,
    baseRef: "HEAD",
    baseCommit: execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
  });

  return { whiteboardHome, whiteboardDir: created.dir };
}

async function globalPackage(manager: WhiteboardPackageManager): Promise<{
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
