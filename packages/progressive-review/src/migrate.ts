import { execFile, spawn } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";
import { promisify } from "node:util";

import {
  type JsonObject,
  isJsonObject,
  jsonBoolean,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";

import { emitJsonEvent, humanStream } from "./cli-output";
import { errorMessage } from "./error-message";
import { defaultPackageRoot } from "./install";
import {
  ensureReviewPinnedCheckout,
  removeLegacyReviewCheckouts,
} from "./review-head-checkout";
import {
  type StoredReviewRecord,
  parseStoredReviewRecord,
  parseStoredReviewRecordForMigration,
} from "./review-home";
import { devReviewHome } from "./review-storage";
import { reviewVcs } from "./review-vcs";
import { writePrivateJsonAtomic } from "./server/desktop-paths";
import {
  auditStoredReviewDocuments,
  migrateStoredReviewData,
} from "./stored-review-migration";

const PACKAGE_NAME = "@dev.fast/review";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGACY_SKILL_NAMES = [
  "review",
  "review-map",
  "review-stop",
  "progressive-review",
  "pr-review",
] as const;
const CURRENT_SKILL_NAMES = [
  "dev-review",
  "dev-review-map",
  "trace-archaeology",
] as const;
const execFilePromise = promisify(execFile);

export type ReviewPackageManager = "npm" | "pnpm" | "yarn" | "bun";

interface CleanupResult {
  checked: number;
  removed: number;
  blockers: string[];
}

interface JjMigrationResult {
  checked: number;
  migrated: number;
  blockers: string[];
}

interface ManagedCheckoutMigrationResult {
  checked: number;
  created: number;
  legacyRemoved: number;
  blockers: string[];
}

interface RunReviewMigrationRuntime {
  migrateStoredReviewData: typeof migrateStoredReviewData;
  migrateJjReviewRepositories: typeof migrateJjReviewRepositories;
  migrateReviewManagedCheckouts: typeof migrateReviewManagedCheckouts;
  auditStoredReviewDocuments: typeof auditStoredReviewDocuments;
  removeLegacyDesktopCatalog: typeof removeLegacyDesktopCatalog;
  removeLegacyReviewSkills: typeof removeLegacyReviewSkills;
  removeLegacyGlobalReviewInstalls: typeof removeLegacyGlobalReviewInstalls;
}

export async function runReviewMigration(input: {
  env?: NodeJS.ProcessEnv;
  force?: boolean;
  json?: boolean;
  homeDir?: string;
  packageRoot?: string;
  stdout: Writable;
  stderr: Writable;
  runtime?: Partial<RunReviewMigrationRuntime>;
}): Promise<number> {
  const human = humanStream(input);
  const env = input.env ?? process.env;
  const homeDir = input.homeDir ?? os.homedir();
  const reviewHome = devReviewHome(env, homeDir);
  const packageRoot = input.packageRoot ?? defaultPackageRoot();
  const runtime: RunReviewMigrationRuntime = {
    migrateStoredReviewData,
    migrateJjReviewRepositories,
    migrateReviewManagedCheckouts,
    auditStoredReviewDocuments,
    removeLegacyDesktopCatalog,
    removeLegacyReviewSkills,
    removeLegacyGlobalReviewInstalls,
    ...input.runtime,
  };

  const blockers: string[] = [];
  const stored = await runMigrationPhase(
    "Old Review cleanup",
    {
      documents: 0,
      droppedLegacyPeekReviews: 0,
      droppedReviews: 0,
      droppedComments: 0,
      droppedQuestions: 0,
      legacyCheckoutsRemoved: 0,
      upgradedThreadDatabases: 0,
    },
    () =>
      runtime.migrateStoredReviewData({
        reviewHome,
        force: input.force,
        log: (message) => input.stderr.write(`${message}\n`),
        onBlocker: (message) => blockers.push(message),
      }),
    blockers,
  );
  const jj = await runMigrationPhase(
    "jj repository migration",
    { checked: 0, migrated: 0, blockers: [] },
    () =>
      runtime.migrateJjReviewRepositories({
        reviewHome,
        skipReviewUuids: stored.failedReviewUuids,
        force: input.force,
        log: (message) => input.stderr.write(`${message}\n`),
      }),
    blockers,
  );
  const managedCheckouts = await runMigrationPhase(
    "Review-managed checkout migration",
    { checked: 0, created: 0, legacyRemoved: 0, blockers: [] },
    () =>
      runtime.migrateReviewManagedCheckouts({
        reviewHome,
        skipReviewUuids: stored.failedReviewUuids,
        log: (message) => input.stderr.write(`${message}\n`),
      }),
    blockers,
  );
  const audit = await runMigrationPhase(
    "Review document audit",
    { documents: 0, issues: [] },
    () =>
      runtime.auditStoredReviewDocuments({
        reviewHome,
        skipReviewUuids: stored.failedReviewUuids,
        onlyUnpresented: true,
      }),
    blockers,
  );
  const catalog = await runMigrationPhase(
    "obsolete Desktop catalog cleanup",
    { checked: 0, removed: 0, blockers: [] },
    () => runtime.removeLegacyDesktopCatalog({ reviewHome }),
    blockers,
  );
  const skills = await runMigrationPhase(
    "legacy skill cleanup",
    { checked: 0, removed: 0, blockers: [] },
    () =>
      runtime.removeLegacyReviewSkills({
        homeDir,
        packageRoot,
      }),
    blockers,
  );
  const globalCli = await runMigrationPhase(
    "legacy global CLI cleanup",
    { checked: 0, removed: 0, blockers: [] },
    () =>
      runtime.removeLegacyGlobalReviewInstalls({
        packageRoot,
        homeDir,
        env,
        desktopManagedCli: false,
        stdout: input.stdout,
        stderr: input.stderr,
      }),
    blockers,
  );

  blockers.push(
    ...jj.blockers,
    ...managedCheckouts.blockers,
    ...catalog.blockers,
    ...skills.blockers,
    ...globalCli.blockers,
  );
  if (audit.issues.length > 0) {
    const affectedDocuments = new Set(
      audit.issues.map((issue) => issue.filePath),
    ).size;
    blockers.push(
      `${count(audit.issues.length, "authoring issue")} across ${count(affectedDocuments, "Review document")} needs an agent.`,
    );
    for (const issue of audit.issues) {
      human.write(
        `${issue.filePath}:${issue.line} ${issue.code}: ${issue.message}\n`,
      );
    }
    human.write(
      "Correct these Review documents and rerun `review migrate apply`.\n",
    );
  }

  const stateChanged = stored.droppedComments + stored.droppedQuestions;
  human.write(
    [
      `Review migration: ${count(stored.documents, "document")} checked;`,
      `${count(stored.droppedReviews, "old Review")} dropped;`,
      `${count(stored.droppedLegacyPeekReviews, "legacy-peek Review")} dropped;`,
      `${count(jj.migrated, "jj repository", "jj repositories")} converted;`,
      `${count(managedCheckouts.created, "managed checkout")} created;`,
      `${count(stored.legacyCheckoutsRemoved + managedCheckouts.legacyRemoved, "legacy checkout")} removed;`,
      `${count(stored.upgradedThreadDatabases, "thread database")} upgraded;`,
      `${count(stateChanged, "state record")} migrated or dropped;`,
      `${count(catalog.removed, "catalog entry", "catalog entries")} removed;`,
      `${count(skills.removed, "skill")} removed;`,
      `${count(globalCli.removed, "global CLI installation")} removed;`,
      `${count(blockers.length, "blocker")}.`,
    ].join(" ") + "\n",
  );
  for (const blocker of blockers) {
    input.stderr.write(`Review migration blocker: ${blocker}\n`);
  }
  emitJsonEvent(input, {
    event: "migrated",
    documents: stored.documents,
    droppedReviews: stored.droppedReviews,
    droppedLegacyPeekReviews: stored.droppedLegacyPeekReviews,
    jjRepositories: jj.migrated,
    managedCheckouts: managedCheckouts.created,
    legacyCheckouts:
      stored.legacyCheckoutsRemoved + managedCheckouts.legacyRemoved,
    stateRecords: stateChanged,
    catalogEntries: catalog.removed,
    skills: skills.removed,
    globalCliInstallations: globalCli.removed,
    issues: audit.issues.map((issue) => ({
      file: issue.filePath,
      line: issue.line,
      code: issue.code,
      message: issue.message,
    })),
    blockers,
  });
  return blockers.length === 0 ? 0 : 1;
}

export async function migrateReviewManagedCheckouts(input: {
  reviewHome: string;
  skipReviewUuids?: readonly string[];
  log?: (message: string) => void;
}): Promise<ManagedCheckoutMigrationResult> {
  const reviewsRoot = path.join(input.reviewHome, "reviews");
  const result: ManagedCheckoutMigrationResult = {
    checked: 0,
    created: 0,
    legacyRemoved: 0,
    blockers: [],
  };
  const sourceRoots = new Set<string>();
  for (const entry of await readDirectory(reviewsRoot)) {
    if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
    if (input.skipReviewUuids?.includes(entry.name)) continue;
    const reviewDir = path.join(reviewsRoot, entry.name);
    result.checked += 1;
    try {
      const review = parseStoredReviewRecord(
        JSON.parse(await readFile(path.join(reviewDir, "review.json"), "utf8")),
      );
      if (review.uuid !== entry.name) {
        throw new Error("review.json UUID does not match its directory");
      }
      sourceRoots.add(review.worktreePath);
      const pins = [
        review.sourceCommit
          ? { role: "head" as const, commit: review.sourceCommit }
          : null,
        review.baseCommit && review.baseCommit !== review.sourceCommit
          ? { role: "base" as const, commit: review.baseCommit }
          : null,
      ].filter((pin): pin is NonNullable<typeof pin> => Boolean(pin));
      for (const pin of pins) {
        const checkout = await ensureReviewPinnedCheckout({
          rootPath: review.worktreePath,
          ref: pin.commit,
          reviewUuid: review.uuid,
          role: pin.role,
        });
        if (!checkout) {
          throw new Error(
            `cannot create ${pin.role} checkout at ${pin.commit}`,
          );
        }
        result.created += 1;
      }
      input.log?.(`Created managed checkouts for Review ${review.uuid}.`);
    } catch (error) {
      result.blockers.push(`${reviewDir}: ${errorMessage(error)}`);
    }
  }
  for (const sourceRoot of sourceRoots) {
    try {
      result.legacyRemoved += await removeLegacyReviewCheckouts({
        rootPath: sourceRoot,
        onBlocker: (message) => result.blockers.push(message),
      });
    } catch (error) {
      result.blockers.push(
        `${sourceRoot}: legacy checkout cleanup failed: ${errorMessage(error)}`,
      );
    }
  }
  return result;
}

async function runMigrationPhase<T>(
  label: string,
  fallback: T,
  phase: () => Promise<T>,
  blockers: string[],
): Promise<T> {
  try {
    return await phase();
  } catch (error) {
    blockers.push(`${label} failed: ${errorMessage(error)}`);
    return fallback;
  }
}

export async function migrateJjReviewRepositories(input: {
  reviewHome: string;
  skipReviewUuids?: readonly string[];
  force?: boolean;
  log?: (message: string) => void;
}): Promise<JjMigrationResult> {
  const reviewsRoot = path.join(input.reviewHome, "reviews");
  const result: JjMigrationResult = {
    checked: 0,
    migrated: 0,
    blockers: [],
  };
  for (const entry of await readDirectory(reviewsRoot)) {
    if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
    const reviewDir = path.join(reviewsRoot, entry.name);
    if (!(await pathExists(path.join(reviewDir, ".jj")))) continue;
    if (input.skipReviewUuids?.includes(entry.name)) continue;
    result.checked += 1;
    let recordSource: string;
    try {
      recordSource = await readFile(
        path.join(reviewDir, "review.json"),
        "utf8",
      );
      const parsed = parseStoredReviewRecordForMigration(
        JSON.parse(recordSource),
      );
      if (parsed.uuid !== entry.name) {
        throw new Error("review.json UUID does not match its directory");
      }
      // The current implementation already reads the colocated Git objects.
      // Rebuilding from the worktree would erase immutable publication history.
      if (
        parsed.presentedDocumentRevision ||
        parsed.presentedSoftwareMapRevision ||
        (await reviewVcs.log(reviewDir)).length > 0
      ) {
        input.log?.(
          `Preserved colocated Review history for ${parsed.uuid}; no repository reset is needed.`,
        );
        continue;
      }
      await resetJjReviewRepository({
        reviewDir,
        review: parsed,
        recordSource,
        force: input.force,
      });
      input.log?.(`Converted jj Review repository ${reviewDir} to plain Git.`);
      result.migrated += 1;
    } catch (error) {
      result.blockers.push(`${reviewDir}: ${errorMessage(error)}`);
    }
  }
  return result;
}

async function resetJjReviewRepository(input: {
  reviewDir: string;
  review: StoredReviewRecord;
  recordSource: string;
  force?: boolean;
}): Promise<void> {
  const gitDir = path.join(input.reviewDir, ".git");
  const jjDir = path.join(input.reviewDir, ".jj");
  const backupDir = `${input.reviewDir}.review-migrate-git-backup`;
  const backupExists = await pathExists(backupDir);
  if (backupExists && !input.force) {
    throw new Error(
      `an interrupted Git backup exists at ${backupDir}; rerun with --force`,
    );
  }
  if (backupExists) {
    await rm(backupDir, { recursive: true, force: true });
  }

  let movedGit = false;
  try {
    await rename(gitDir, backupDir);
    movedGit = true;
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
    if (!input.force) {
      throw new Error("the colocated .git directory is missing");
    }
  }

  try {
    await writePrivateJsonAtomic(path.join(input.reviewDir, "review.json"), {
      ...input.review,
      presentedDocumentRevision: null,
      presentedSoftwareMapRevision: null,
    });
    await reviewVcs.init(input.reviewDir);
    const excludeDir = path.join(gitDir, "info");
    await mkdir(excludeDir, { recursive: true });
    await writeFile(path.join(excludeDir, "exclude"), ".jj/\n", "utf8");
    const revision = await reviewVcs.seal(
      input.reviewDir,
      "Migrate Review history to plain Git",
    );
    await reviewVcs.resolve(input.reviewDir, revision);
    const stored = parseStoredReviewRecord(
      JSON.parse(
        await readFile(path.join(input.reviewDir, "review.json"), "utf8"),
      ),
    );
    if (
      stored.uuid !== input.review.uuid ||
      stored.presentedDocumentRevision !== null ||
      stored.presentedSoftwareMapRevision !== null
    ) {
      throw new Error("the migrated review.json did not verify");
    }
    await rm(jjDir, { recursive: true, force: false });
  } catch (error) {
    await rm(gitDir, { recursive: true, force: true });
    if (movedGit && (await pathExists(backupDir))) {
      await rename(backupDir, gitDir);
    }
    await writeFile(
      path.join(input.reviewDir, "review.json"),
      input.recordSource,
      "utf8",
    );
    throw error;
  }
  if (movedGit) {
    await rm(backupDir, { recursive: true, force: false });
  }
}

export async function removeLegacyDesktopCatalog(input: {
  reviewHome: string;
}): Promise<CleanupResult> {
  const directory = path.join(input.reviewHome, "review-desktop", "reviews");
  const result: CleanupResult = { checked: 0, removed: 0, blockers: [] };
  for (const entry of await readDirectory(directory)) {
    if (!entry.isFile() || path.extname(entry.name) !== ".json") continue;
    const filePath = path.join(directory, entry.name);
    result.checked += 1;
    const key = entry.name.slice(0, -5);
    if (!/^[a-f0-9]{32}$/.test(key)) {
      result.blockers.push(`${filePath} has an unknown catalog file name.`);
      continue;
    }
    let record: JsonObject;
    try {
      const value = parseJsonText(await readFile(filePath, "utf8"));
      if (!isJsonObject(value)) {
        throw new Error("catalog entry must contain an object");
      }
      record = value;
    } catch (error) {
      result.blockers.push(
        `${filePath} is not valid JSON: ${errorMessage(error)}`,
      );
      continue;
    }
    if (!isLegacyDesktopCatalogRecord(record, key)) {
      result.blockers.push(
        `${filePath} is not a recognized Review catalog entry.`,
      );
      continue;
    }
    await rm(filePath, { force: false });
    result.removed += 1;
  }
  return result;
}

function isLegacyDesktopCatalogRecord(
  record: JsonObject,
  reviewKey: string,
): boolean {
  const repository = record.repository;
  if (!isJsonObject(repository)) return false;
  const requiredStrings = [
    record.rootPath,
    record.reviewPath,
    record.baseRef,
    record.routePath,
    repository.repositoryId,
    repository.repositoryPath,
    repository.worktreeRoot,
  ];
  return (
    record.reviewKey === reviewKey &&
    requiredStrings
      .map(jsonString)
      .every((value) => value !== undefined && value.length > 0) &&
    ["git", "jj", "none"].includes(String(repository.kind)) &&
    Number.isSafeInteger(record.startedAt) &&
    Number(record.startedAt) > 0 &&
    Number.isSafeInteger(record.updatedAt) &&
    Number(record.updatedAt) > 0 &&
    ["active", "completed", "dismissed", "unavailable"].includes(
      String(record.state),
    ) &&
    jsonBoolean(record.available) !== undefined &&
    (record.headRef === undefined ||
      jsonString(record.headRef) !== undefined) &&
    (record.pullRequestNumber === undefined ||
      (Number.isSafeInteger(record.pullRequestNumber) &&
        Number(record.pullRequestNumber) > 0)) &&
    (record.outcome === undefined ||
      record.outcome === "submitted" ||
      record.outcome === "dismissed")
  );
}

export async function removeLegacyReviewSkills(input: {
  homeDir: string;
  packageRoot: string;
}): Promise<CleanupResult> {
  const roots = [
    path.join(input.homeDir, ".claude", "skills"),
    path.join(input.homeDir, ".agents", "skills"),
    path.join(input.homeDir, ".cursor", "skills"),
  ];
  const result: CleanupResult = { checked: 0, removed: 0, blockers: [] };
  for (const root of roots) {
    for (const name of LEGACY_SKILL_NAMES) {
      const skillDir = path.join(root, name);
      if (!(await pathExists(skillDir))) continue;
      result.checked += 1;
      if (!(await isOwnedLegacySkill(skillDir, name))) {
        result.blockers.push(
          `${skillDir} is not a positively identified Review-owned skill.`,
        );
        continue;
      }
      await rm(skillDir, { recursive: true, force: false });
      result.removed += 1;
    }
    for (const name of CURRENT_SKILL_NAMES) {
      const skillDir = path.join(root, name);
      if (!(await pathExists(skillDir))) continue;
      const installed = await readSkillSource(skillDir);
      const bundled = await readSkillSource(
        path.join(input.packageRoot, "skills", name),
      );
      if (
        installed === undefined ||
        bundled === undefined ||
        installed !== bundled
      ) {
        result.blockers.push(
          `${skillDir} is a current skill with unclear ownership; it was not removed.`,
        );
      }
    }
  }
  return result;
}

async function isOwnedLegacySkill(
  skillDir: string,
  expectedName: string,
): Promise<boolean> {
  try {
    const metadata = await lstat(skillDir);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false;
    const source = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1];
    const name = frontmatter?.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1];
    return (
      name === expectedName &&
      /@dev\.fast\/review|dev\.fast Review|progressive Review/i.test(source)
    );
  } catch {
    return false;
  }
}

async function readSkillSource(skillDir: string): Promise<string | undefined> {
  try {
    const metadata = await lstat(skillDir);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return undefined;
    return await readFile(path.join(skillDir, "SKILL.md"), "utf8");
  } catch {
    return undefined;
  }
}

type RunCommand = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

type RunProcess = (input: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  stdout: Writable;
  stderr: Writable;
}) => Promise<number>;

export async function removeLegacyGlobalReviewInstalls(input: {
  packageRoot: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  desktopManagedCli: boolean;
  stdout: Writable;
  stderr: Writable;
  runCommand?: RunCommand;
  runProcess?: RunProcess;
}): Promise<CleanupResult> {
  const result: CleanupResult = { checked: 0, removed: 0, blockers: [] };
  const currentPackageRoot = await canonicalPath(input.packageRoot);
  const runCommand =
    input.runCommand ??
    (async (command, args) => {
      const executed = await execFilePromise(command, args, {
        encoding: "utf8",
        env: input.env,
      });
      return { stdout: executed.stdout, stderr: executed.stderr };
    });
  const runProcess = input.runProcess ?? spawnProcess;
  const seen = new Set<string>();

  for (const manager of ["npm", "pnpm", "yarn", "bun"] as const) {
    const roots = await globalPackageRoots({
      manager,
      homeDir: input.homeDir,
      runCommand,
    });
    for (const root of roots) {
      const packageRoot = path.join(root, PACKAGE_NAME);
      const packagePath = path.join(packageRoot, "package.json");
      if (!(await pathExists(packagePath))) continue;
      const canonicalRoot = await canonicalPath(packageRoot);
      if (seen.has(canonicalRoot)) continue;
      seen.add(canonicalRoot);
      result.checked += 1;
      try {
        const metadata = parseJsonText(await readFile(packagePath, "utf8"));
        if (!isJsonObject(metadata) || metadata.name !== PACKAGE_NAME) {
          result.blockers.push(
            `${packageRoot} is not a positively identified ${PACKAGE_NAME} installation.`,
          );
          continue;
        }
      } catch (error) {
        result.blockers.push(
          `${packagePath} cannot be verified: ${errorMessage(error)}`,
        );
        continue;
      }

      if (
        samePath(canonicalRoot, currentPackageRoot) ||
        !input.desktopManagedCli
      ) {
        result.blockers.push(
          `${packageRoot} is a legacy global Review CLI, but no separate Desktop-managed review command is available.`,
        );
        continue;
      }

      const uninstall = packageManagerUninstall(manager);
      const exitCode = await runProcess({
        command: manager,
        args: uninstall,
        env: input.env,
        stdout: input.stdout,
        stderr: input.stderr,
      });
      if (exitCode === 0) {
        result.removed += 1;
      } else {
        result.blockers.push(
          `${manager} could not remove the legacy Review CLI at ${packageRoot}.`,
        );
      }
    }
  }
  return result;
}

async function globalPackageRoots(input: {
  manager: ReviewPackageManager;
  homeDir: string;
  runCommand: RunCommand;
}): Promise<string[]> {
  try {
    if (input.manager === "npm" || input.manager === "pnpm") {
      const root = (
        await input.runCommand(input.manager, ["root", "--global"])
      ).stdout.trim();
      return root ? [root] : [];
    }
    if (input.manager === "yarn") {
      const root = (
        await input.runCommand("yarn", ["global", "dir"])
      ).stdout.trim();
      return root ? [root, path.join(root, "node_modules")] : [];
    }
    const bin = (
      await input.runCommand("bun", ["pm", "bin", "--global"])
    ).stdout.trim();
    return uniquePaths([
      path.join(input.homeDir, ".bun", "install", "global", "node_modules"),
      ...(bin
        ? [path.join(path.dirname(bin), "install", "global", "node_modules")]
        : []),
    ]);
  } catch {
    return [];
  }
}

function packageManagerUninstall(manager: ReviewPackageManager): string[] {
  if (manager === "npm") return ["uninstall", "--global", PACKAGE_NAME];
  if (manager === "pnpm") return ["remove", "--global", PACKAGE_NAME];
  if (manager === "yarn") return ["global", "remove", PACKAGE_NAME];
  return ["remove", "--global", PACKAGE_NAME];
}

function spawnProcess(input: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  stdout: Writable;
  stderr: Writable;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      env: input.env,
      stdio: ["inherit", input.stdout, input.stderr],
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) {
        reject(new Error(`${input.command} terminated by signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function readDirectory(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function canonicalPath(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return path.resolve(target);
  }
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((value) => path.resolve(value)))];
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function count(value: number, noun: string, plural = `${noun}s`): string {
  return `${value} ${value === 1 ? noun : plural}`;
}
