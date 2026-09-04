import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { currentHead, listCommitRange } from "@dev.fast/local-vcs";
import {
  DEFAULT_DISMISSED_RETENTION_DAYS,
  type JsonObject,
  type JsonValue,
  REVIEW_SCHEMA_VERSION,
  type ReviewAgentSessionRole,
  type ReviewDescriptor,
  type ReviewRecord,
  ReviewRecordSchema,
  type ReviewSourceIdentity,
  isJsonObject,
  jsonObject,
  jsonString,
  parseJsonText,
  summarizeReviewDiffFiles,
} from "@dev.fast/review-protocol";

import {
  type SessionRef,
  authoringSessionKey,
  parseAuthoringSessionKey,
  parseFreshSourceSessionHarness,
} from "./authoring-session";
import { isMissingFileError } from "./native-agent/transcript-json";
import { type DismissedRetentionDays, reviewReapsAt } from "./review-attention";
import {
  remapReviewCodeDrafts,
  remapReviewCodeThreads,
} from "./review-code-target-remap";
import { resolveReviewDiffFiles } from "./review-diff-files";
import {
  deleteReviewState,
  putReviewRecord,
  readReviewRecord,
} from "./review-state-db";
import { readReviewComments } from "./review-state-store";
import { devReviewHome } from "./review-storage";
import {
  ReviewThreadDbVersionError,
  checkReviewThreadDbVersion,
  createReviewThreadDb,
  reviewThreadStoreBackend,
} from "./review-thread-store-backend";
import { reviewVcs } from "./review-vcs";
import { writePrivateJsonAtomic } from "./server/desktop-paths";
import { resolveReviewRepositoryIdentity } from "./server/repository-identity";
import { withFileLock } from "./with-file-lock";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CreateReviewDirBinding {
  uuid?: string;
  reviewsHomePath?: string;
  visibility?: "system";
  worktreePath: string;
  baseRef: string;
  baseCommit: string;
  sourceCommit?: string | null;
  sourceIdentity?: ReviewSourceIdentity | null;
  pullRequestNumber?: number | null;
  pullRequestUrl?: string | null;
  title?: string;
  sourceSession?: string;
}

export const DISABLED_REVIEW_SOURCE_SESSION = "disabled:review";

export const StoredReviewRecordSchema = ReviewRecordSchema;
export type StoredReviewRecord = ReviewRecord;

export interface StoredReview {
  dir: string;
  review: StoredReviewRecord;
}

export interface ListReviewsFilter {
  worktreePath?: string;
  repoKey?: string;
  status?: ReviewRecord["status"];
  includeSystem?: boolean;
}

export interface ReviewHomeError {
  reviewDir: string;
  reviewUuid: string | null;
  title: string;
  worktreePath: string;
  lastPublishedAt: string | null;
  message: string;
  code?: string;
}

export interface ListReviewsResult {
  reviews: StoredReview[];
  errors: ReviewHomeError[];
}

export class ReviewHomeScanError extends Error {
  override readonly name = "ReviewHomeScanError";

  constructor(readonly errors: readonly ReviewHomeError[]) {
    super(
      `Could not read reviews:\n${errors.map((error) => `${error.reviewDir}: ${error.message}`).join("\n")}`,
    );
  }
}

export function reviewsHomeDir(devHome = devReviewHome()): string {
  return path.join(devHome, "reviews");
}

export async function createReviewDir(
  binding: CreateReviewDirBinding,
): Promise<StoredReview> {
  const uuid = binding.uuid ?? createReviewUuid();
  if (!UUID_PATTERN.test(uuid)) {
    throw new Error(`Review UUID is invalid: ${uuid}`);
  }
  const reviewHome = binding.reviewsHomePath ?? devReviewHome();
  const dir = path.join(reviewsHomeDir(reviewHome), uuid);
  const worktreePath = path.resolve(binding.worktreePath);
  const repository = await resolveReviewRepositoryIdentity(worktreePath);
  const createdAt = new Date().toISOString();
  const sourceSession = binding.sourceSession ?? DISABLED_REVIEW_SOURCE_SESSION;
  const attributedAgentSession = parseAuthoringSessionKey(sourceSession)
    ? sourceSession
    : null;
  const review: StoredReviewRecord = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    uuid,
    repoKey: repository.repositoryId,
    worktreePath,
    baseRef: binding.baseRef,
    baseCommit: binding.baseCommit,
    sourceCommit: binding.sourceCommit ?? null,
    sourceIdentity: binding.sourceIdentity ?? null,
    pullRequestNumber: binding.pullRequestNumber ?? null,
    pullRequestUrl: binding.pullRequestUrl ?? null,
    title: binding.title ?? "Progressive Review",
    sourceSession,
    status: "draft",
    presentedDocumentRevision: null,
    presentedSoftwareMapRevision: null,
    createdAt,
    lastPublishedAt: null,
  };
  if (binding.visibility) review.visibility = binding.visibility;
  if (attributedAgentSession) {
    review.agentSessions = {
      [attributedAgentSession]: {
        roles: ["author"],
        firstSeenAt: createdAt,
        lastSeenAt: createdAt,
      },
    };
  }

  await mkdirReviewDir(dir);
  try {
    await reviewVcs.init(dir);
    await Promise.all([
      writeFile(path.join(dir, "review.mdx"), defaultReviewMdx(review), "utf8"),
      writeFile(path.join(dir, "data.ts"), "export {};\n", "utf8"),
      writeFile(
        path.join(dir, "package.json"),
        `${JSON.stringify(reviewPackageJson(uuid), null, 2)}\n`,
        "utf8",
      ),
      writeFile(path.join(dir, "review-test.mjs"), reviewTestShim, "utf8"),
      writeFile(path.join(dir, ".gitignore"), reviewGitignore, "utf8"),
    ]);
    createReviewThreadDb(dir, reviewHome);
    await persistStoredReviewRecord(dir, review, reviewHome);
  } catch (error) {
    deleteReviewState(dir, reviewHome);
    await rm(dir, { recursive: true, force: true });
    throw error;
  }

  return { dir, review };
}

const AGENT_SESSION_LOCK_OPTIONS = {
  retryMs: 10,
  staleMs: 30_000,
  timeoutMs: 2_000,
  unownedGraceMs: 1_000,
  heartbeatMs: 5_000,
} as const;

export async function touchReviewAgentSession(
  review: StoredReview,
  sessionKey: string,
  role: ReviewAgentSessionRole,
  now = new Date().toISOString(),
): Promise<StoredReview> {
  if (!parseAuthoringSessionKey(sessionKey)) {
    throw new Error(`Review agent session key is invalid: ${sessionKey}`);
  }
  const outcome = await withFileLock(
    path.join(review.dir, ".agent-sessions.lock"),
    AGENT_SESSION_LOCK_OPTIONS,
    async () => {
      const loaded = await readStoredReview(review.dir);
      if ("error" in loaded) throw new ReviewHomeScanError([loaded.error]);
      const current = loaded.review;
      const prior = current.agentSessions?.[sessionKey];
      const roles = prior?.roles.includes(role)
        ? prior.roles
        : [...(prior?.roles ?? []), role];
      const updated: StoredReviewRecord = {
        ...current,
        agentSessions: {
          ...current.agentSessions,
          [sessionKey]: {
            roles,
            firstSeenAt: prior?.firstSeenAt ?? now,
            lastSeenAt: now,
          },
        },
      };
      await persistStoredReviewRecord(review.dir, updated);
      return { dir: review.dir, review: updated };
    },
  );
  if (!outcome.acquired) {
    throw new Error(
      `Timed out while updating agent sessions for Review ${review.review.uuid}.`,
    );
  }
  return outcome.result;
}

/** Replaces a tutorial's fresh-session marker with the real source session.
    The record and author attribution move together under the same lock so a
    restart can never observe one without the other. */
export async function bindReviewAuthorSession(
  review: StoredReview,
  session: SessionRef,
  now = new Date().toISOString(),
): Promise<StoredReview> {
  const sessionKey = authoringSessionKey(session);
  const outcome = await withFileLock(
    path.join(review.dir, ".agent-sessions.lock"),
    AGENT_SESSION_LOCK_OPTIONS,
    async () => {
      const loaded = await readStoredReview(review.dir);
      if ("error" in loaded) throw new ReviewHomeScanError([loaded.error]);
      const current = loaded.review;
      const freshHarness = parseFreshSourceSessionHarness(
        current.sourceSession,
      );
      const boundSession = parseAuthoringSessionKey(current.sourceSession);
      if (freshHarness && freshHarness !== session.harness) {
        throw new Error(
          `Review fresh-session harness ${freshHarness} does not match ${session.harness}.`,
        );
      }
      if (
        !freshHarness &&
        (!boundSession || authoringSessionKey(boundSession) !== sessionKey)
      ) {
        throw new Error(
          "Review is already bound to another authoring session.",
        );
      }
      const prior = current.agentSessions?.[sessionKey];
      const roles = prior?.roles.includes("author")
        ? prior.roles
        : [...(prior?.roles ?? []), "author" as const];
      const updated: StoredReviewRecord = {
        ...current,
        sourceSession: sessionKey,
        agentSessions: {
          ...current.agentSessions,
          [sessionKey]: {
            roles,
            firstSeenAt: prior?.firstSeenAt ?? now,
            lastSeenAt: now,
          },
        },
      };
      await persistStoredReviewRecord(review.dir, updated);
      return { dir: review.dir, review: updated };
    },
  );
  if (!outcome.acquired) {
    throw new Error(
      `Timed out while binding the author session for Review ${review.review.uuid}.`,
    );
  }
  return outcome.result;
}

export async function sealReviewCandidate(
  dir: string,
  message: string,
): Promise<string> {
  return reviewVcs.seal(dir, message);
}

export async function updateReviewPins(
  review: StoredReview,
  pins: {
    baseRef: string;
    baseCommit: string;
    sourceCommit: string;
    sourceIdentity: ReviewSourceIdentity;
    sourceSession: string;
  },
): Promise<StoredReview> {
  if (
    review.review.baseRef === pins.baseRef &&
    review.review.baseCommit === pins.baseCommit &&
    review.review.sourceCommit === pins.sourceCommit &&
    review.review.sourceSession === pins.sourceSession &&
    review.review.sourceIdentity?.kind === pins.sourceIdentity.kind &&
    review.review.sourceIdentity.name === pins.sourceIdentity.name
  ) {
    return review;
  }
  const now = new Date().toISOString();
  const sourceAttribution = parseAuthoringSessionKey(pins.sourceSession)
    ? {
        agentSessions: {
          ...review.review.agentSessions,
          [pins.sourceSession]: {
            roles: ["updater" as const],
            firstSeenAt:
              review.review.agentSessions?.[pins.sourceSession]?.firstSeenAt ??
              now,
            lastSeenAt: now,
          },
        },
      }
    : {};
  const refreshed: StoredReview = {
    ...review,
    review: { ...review.review, ...pins, ...sourceAttribution },
  };
  const threadStore = reviewThreadStoreBackend(
    path.join(refreshed.dir, "review.mdx"),
  );
  const drafts = threadStore.readCommentDrafts();
  const comments = await remapReviewCodeThreads({
    rootPath: refreshed.review.worktreePath,
    comments: threadStore.readComments(),
    from: {
      baseCommit: review.review.baseCommit,
      sourceCommit: review.review.sourceCommit,
    },
    to: {
      baseCommit: refreshed.review.baseCommit,
      sourceCommit: refreshed.review.sourceCommit,
    },
  });
  const remappedDrafts = await remapReviewCodeDrafts({
    rootPath: refreshed.review.worktreePath,
    drafts,
    to: {
      baseCommit: refreshed.review.baseCommit,
      sourceCommit: refreshed.review.sourceCommit,
    },
  });
  await persistStoredReviewRecord(refreshed.dir, refreshed.review);
  threadStore.writeCommentState(comments, remappedDrafts);
  return refreshed;
}

export function createReviewUuid(): string {
  return randomUUID();
}

/** The document's first ATX H1, used as the Review display title. */
export async function reviewTitleFromDocument(
  documentPath: string,
): Promise<string | undefined> {
  const document = await readFile(documentPath, "utf8");
  for (const line of document.split(/\r?\n/)) {
    const heading = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) return heading[1].trim() || undefined;
  }
  return undefined;
}

export async function findReview(uuid: string): Promise<StoredReview | null> {
  if (!UUID_PATTERN.test(uuid)) {
    throw new Error(`Review UUID is invalid: ${uuid}`);
  }
  const loaded = await readStoredReview(path.join(reviewsHomeDir(), uuid));
  if ("error" in loaded) {
    if (loaded.error.code === "ENOENT") return null;
    throw new ReviewHomeScanError([loaded.error]);
  }
  if (loaded.review.uuid !== uuid) {
    throw new ReviewHomeScanError([
      reviewHomeError(loaded.dir, loaded.review, {
        message: "review.json UUID does not match its directory.",
      }),
    ]);
  }
  return loaded;
}

export async function reviewDescriptor(
  stored: StoredReview,
  retentionDays: DismissedRetentionDays = DEFAULT_DISMISSED_RETENTION_DAYS,
): Promise<ReviewDescriptor> {
  const documentPath = path.join(stored.dir, "review.mdx");
  const [reviewDirExists, worktreeExists, documentStats] = await Promise.all([
    pathExists(stored.dir),
    pathExists(stored.review.worktreePath),
    statIfExists(documentPath),
  ]);
  const documentExists = documentStats !== null;
  const available = reviewDirExists && worktreeExists && documentExists;
  /* Same diff target as the review document (resolveRequestDiffTarget):
     the pinned baseCommit..sourceCommit from review.json. An empty diff
     reports null so the views omit the numbers, as the document does. */
  const headCommit = stored.review.sourceCommit ?? stored.review.baseCommit;
  const [diffStats, commits] = await Promise.all([
    worktreeExists && stored.review.sourceCommit
      ? resolveReviewDiffFiles({
          rootPath: stored.review.worktreePath,
          baseRef: stored.review.baseCommit,
          headRef: stored.review.sourceCommit,
          includePatch: false,
        })
          .then(({ files }) =>
            files.length ? summarizeReviewDiffFiles(files) : null,
          )
          .catch(() => null)
      : null,
    worktreeExists && headCommit !== stored.review.baseCommit
      ? listCommitRange({
          rootPath: stored.review.worktreePath,
          baseRef: stored.review.baseCommit,
          headRef: headCommit,
        }).catch(() => [])
      : [],
  ]);
  const commentCount = documentExists ? countReviewComments(documentPath) : 0;
  return {
    uuid: stored.review.uuid,
    title: stored.review.title,
    status: stored.review.status,
    worktreePath: stored.review.worktreePath,
    repoKey: stored.review.repoKey,
    sourceBranch: stored.review.sourceIdentity?.name ?? null,
    baseRef: stored.review.baseRef,
    headRef: stored.review.sourceIdentity?.name ?? headCommit.slice(0, 8),
    commits,
    pullRequestNumber: stored.review.pullRequestNumber ?? null,
    pullRequestUrl: stored.review.pullRequestUrl ?? null,
    diffStats,
    commentCount,
    documentUpdatedAt: documentStats?.mtime.toISOString() ?? null,
    presentedDocumentRevision: stored.review.presentedDocumentRevision,
    presentedSoftwareMapRevision: stored.review.presentedSoftwareMapRevision,
    lastPublishedAt: stored.review.lastPublishedAt,
    available,
    viewedAt: stored.review.viewedAt ?? null,
    dismissedAt: stored.review.dismissedAt ?? null,
    reapsAt: reviewReapsAt(stored.review, retentionDays),
  };
}

export function countReviewComments(reviewMdxPath: string): number {
  try {
    return Object.keys(readReviewComments(reviewMdxPath)).length;
  } catch {
    return 0;
  }
}

export async function listReviews(
  filter: ListReviewsFilter = {},
): Promise<ListReviewsResult> {
  let loaded: Array<StoredReview | { error: ReviewHomeError }>;
  try {
    const entries = await readdir(reviewsHomeDir(), { withFileTypes: true });
    loaded = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) =>
          readStoredReview(path.join(reviewsHomeDir(), entry.name)),
        ),
    );
  } catch (error) {
    if (isMissingFileError(error)) {
      return { reviews: [], errors: [] };
    }
    throw error;
  }
  const result: ListReviewsResult = { reviews: [], errors: [] };
  for (const entry of loaded) {
    if ("error" in entry) {
      result.errors.push(entry.error);
      continue;
    }
    if (
      (!filter.includeSystem && entry.review.visibility === "system") ||
      (filter.worktreePath &&
        entry.review.worktreePath !== path.resolve(filter.worktreePath)) ||
      (filter.repoKey && entry.review.repoKey !== filter.repoKey) ||
      (filter.status && entry.review.status !== filter.status)
    ) {
      continue;
    }
    const migrationError = reviewThreadMigrationError(entry);
    if (migrationError) result.errors.push(migrationError);
    result.reviews.push(entry);
  }
  return result;
}

function reviewThreadMigrationError(
  stored: StoredReview,
): ReviewHomeError | null {
  try {
    checkReviewThreadDbVersion(path.join(stored.dir, "review.mdx"));
    return null;
  } catch (error) {
    if (!(error instanceof ReviewThreadDbVersionError)) return null;
    return reviewHomeError(stored.dir, stored.review, {
      code: "MIGRATION_REQUIRED",
      message: error.message,
    });
  }
}

export async function computeSync(
  review: ReviewRecord,
  worktreePath: string,
): Promise<boolean> {
  if (!review.sourceCommit) return false;
  const head = await currentHead(worktreePath);
  if (!head) {
    throw new Error(
      `Could not resolve the current source head at ${worktreePath}.`,
    );
  }
  return head.commit === review.sourceCommit;
}

async function mkdirReviewDir(dir: string): Promise<void> {
  await mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
  try {
    await mkdir(dir, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`Review directory already exists: ${dir}`);
    }
    throw error;
  }
}

export async function materializeReviewRevision(
  dir: string,
  revision: string,
  destinationPath: string,
): Promise<void> {
  const resolvedRevision = await reviewVcs.resolve(dir, revision);
  await reviewVcs.materialize(dir, resolvedRevision, destinationPath);
}

export async function readStoredReview(
  dir: string,
): Promise<StoredReview | { error: ReviewHomeError }> {
  try {
    await access(dir);
    const value = readReviewRecord(dir);
    if (value === null) {
      const error = Object.assign(new Error("Review record is missing."), {
        code: "ENOENT",
      });
      throw error;
    }
    const parsed = safeParseStoredReviewRecord(value);
    if (!parsed.success) {
      return {
        error: reviewHomeError(dir, jsonObject(value), {
          message: `Invalid review.json; run \`review migrate apply\`: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
          code: "MIGRATION_REQUIRED",
        }),
      };
    }
    return { dir, review: parsed.data };
  } catch (error) {
    const detail: ReviewHomeErrorDetail = {
      message: `Could not read review.json: ${error instanceof Error ? error.message : String(error)}`,
    };
    // SAFETY: the try block only throws fs ErrnoExceptions and JSON
    // SyntaxErrors; `code` is the errno name on the former and absent on the
    // latter.
    const code = (error as NodeJS.ErrnoException).code;
    if (code) detail.code = code;
    return { error: reviewHomeError(dir, undefined, detail) };
  }
}

/**
 * Persist the authoritative record in SQLite, then refresh review.json as a
 * compatibility mirror for older tooling and sealed historical revisions.
 */
export async function persistStoredReviewRecord(
  dir: string,
  review: StoredReviewRecord,
  reviewHome?: string,
): Promise<void> {
  putReviewRecord(dir, review, reviewHome);
  await writePrivateJsonAtomic(path.join(dir, "review.json"), review);
}

/** `record` is the parsed review, or the raw review.json object when it failed to parse. */
interface ReviewHomeErrorDetail {
  message: string;
  code?: string;
}

function reviewHomeError(
  reviewDir: string,
  record: StoredReviewRecord | JsonObject | undefined,
  error: ReviewHomeErrorDetail,
): ReviewHomeError {
  const directoryUuid = path.basename(reviewDir);
  const storedUuid = jsonString(record?.uuid) ?? null;
  const reviewUuid = UUID_PATTERN.test(storedUuid ?? "")
    ? storedUuid
    : UUID_PATTERN.test(directoryUuid)
      ? directoryUuid
      : null;
  const result: ReviewHomeError = {
    reviewDir,
    reviewUuid,
    title: jsonString(record?.title) ?? "",
    worktreePath: jsonString(record?.worktreePath) || reviewDir,
    lastPublishedAt: jsonString(record?.lastPublishedAt) ?? null,
    message: error.message,
  };
  if (error.code) result.code = error.code;
  return result;
}

export function parseStoredReviewRecord(value: JsonValue): StoredReviewRecord {
  return StoredReviewRecordSchema.parse(stripLegacySoftwareMap(value));
}

export function parseStoredReviewRecordForMigration(
  value: JsonValue,
): StoredReviewRecord {
  if (!isJsonObject(value)) return parseStoredReviewRecord(value);
  const record = stripLegacySoftwareMap(value);
  if (record.schemaVersion === 3) {
    const { agentSession, schemaVersion: _schemaVersion, ...current } = record;
    return StoredReviewRecordSchema.parse({
      ...current,
      schemaVersion: REVIEW_SCHEMA_VERSION,
      sourceSession: current.sourceSession ?? agentSession,
    });
  }
  if (record.schemaVersion !== 2) return parseStoredReviewRecord(record);
  const {
    agentSession,
    presentedRevision,
    schemaVersion: _schemaVersion,
    ...current
  } = record;
  return StoredReviewRecordSchema.parse({
    ...current,
    schemaVersion: REVIEW_SCHEMA_VERSION,
    sourceSession: current.sourceSession ?? agentSession,
    presentedDocumentRevision: presentedRevision ?? null,
    presentedSoftwareMapRevision: presentedRevision ?? null,
  });
}

export function safeParseStoredReviewRecord(value: JsonValue) {
  return StoredReviewRecordSchema.safeParse(stripLegacySoftwareMap(value));
}

function stripLegacySoftwareMap(value: JsonObject): JsonObject;
function stripLegacySoftwareMap(value: JsonValue): JsonValue;
function stripLegacySoftwareMap(value: JsonValue): JsonValue {
  if (!isJsonObject(value)) return value;
  const { softwareMap: _legacySoftwareMap, ...record } = value;
  return record;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

async function statIfExists(targetPath: string) {
  try {
    return await stat(targetPath);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function defaultReviewMdx(review: ReviewRecord): string {
  return `# ${review.title}\n\nThis review document is ready for repo-specific notes.\n\n{/* Review source: ${review.sourceCommit ?? "unbound"} */}\n`;
}

function reviewPackageJson(uuid: string) {
  return {
    name: `review-${uuid}`,
    private: true,
    type: "module",
    scripts: { test: "node review-test.mjs" },
  };
}

// The thread database (and sqlite's transient sidecars) must stay out of the
// review VCS: sealed revisions would otherwise capture nondeterministic binary
// state, and .build/ materializations would carry stale copies of it.
const reviewGitignore = [
  ".build/",
  "review.db",
  "review.db-wal",
  "review.db-shm",
  "",
].join("\n");

const reviewTestShim = [
  'import { spawn } from "node:child_process";',
  "",
  "const rawCommand = process.env.DEV_FAST_REVIEW_INTERNAL_COMMAND;",
  "if (!rawCommand) {",
  '  console.error("DEV_FAST_REVIEW_INTERNAL_COMMAND is required.");',
  "  process.exitCode = 1;",
  "} else {",
  "  const command = JSON.parse(rawCommand);",
  '  const child = spawn(command[0], [...command.slice(1), "internal-test", ...process.argv.slice(2)], {',
  '    stdio: "inherit",',
  "  });",
  '  child.once("error", (error) => { console.error(error); process.exitCode = 1; });',
  '  child.once("exit", (code, signal) => {',
  "    process.exitCode = code ?? (signal ? 1 : 0);",
  "  });",
  "}",
  "",
].join("\n");
