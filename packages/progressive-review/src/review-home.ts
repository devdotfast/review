import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  realpath,
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
import { z } from "zod";

import {
  type SessionRef,
  authoringSessionKey,
  parseAuthoringSessionKey,
  parseFreshSourceSessionHarness,
} from "./authoring-session";
import { errorMessage } from "./error-message";
import { isMissingFileError } from "./native-agent/transcript-json";
import { type DismissedRetentionDays, reviewReapsAt } from "./review-attention";
import {
  remapReviewCodeDrafts,
  remapReviewCodeThreads,
} from "./review-code-target-remap";
import { resolveReviewDiffFiles } from "./review-diff-files";
import {
  ReviewBusyError,
  assertReviewUnchanged,
  withReviewMutationLock,
} from "./review-mutation-lock";
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
  readReviewThreadsReadOnly,
  reviewThreadStoreBackend,
} from "./review-thread-store-backend";
import { reviewVcs } from "./review-vcs";
import { writePrivateJsonAtomic } from "./server/desktop-paths";
import { resolveReviewRepositoryIdentity } from "./server/repository-identity";
import { withFileLock } from "./with-file-lock";

export const UUID_PATTERN =
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

const legacyStoredSourceSessionFields = {
  sourceSession: z.string().min(1).optional(),
  agentSession: z.string().min(1).optional(),
};
const legacyStoredReviewRecordFields = StoredReviewRecordSchema.omit({
  schemaVersion: true,
  sourceSession: true,
});
const LegacyStoredReviewRecordSchema = z
  .union([
    StoredReviewRecordSchema.extend({ schemaVersion: z.literal(4) }),
    legacyStoredReviewRecordFields.extend({
      schemaVersion: z.literal(3),
      ...legacyStoredSourceSessionFields,
    }),
    legacyStoredReviewRecordFields
      .omit({
        presentedDocumentRevision: true,
        presentedSoftwareMapRevision: true,
      })
      .extend({
        schemaVersion: z.literal(2),
        ...legacyStoredSourceSessionFields,
        presentedRevision: z.string().min(1).nullable(),
      }),
  ])
  .refine(
    (record) =>
      Boolean(
        record.sourceSession ||
        ("agentSession" in record && record.agentSession),
      ),
    "A source session is required.",
  );

export interface StoredReview {
  dir: string;
  review: StoredReviewRecord;
}

export interface ListReviewsFilter {
  worktreePath?: string;
  repoKey?: string;
  status?: ReviewRecord["status"];
  includeSystem?: boolean;
  /** Surface a review whose review.json cannot be read, instead of skipping it. */
  reportUnreadableReviews?: boolean;
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
  const outcome = await withReviewMutationLock(review.dir, () =>
    withFileLock(
      path.join(review.dir, ".agent-sessions.lock"),
      AGENT_SESSION_LOCK_OPTIONS,
      async () => {
        const current = parseStoredReviewRecord(readReviewRecord(review.dir));
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
    ),
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
  const outcome = await withReviewMutationLock(review.dir, () =>
    withFileLock(
      path.join(review.dir, ".agent-sessions.lock"),
      AGENT_SESSION_LOCK_OPTIONS,
      async () => {
        const current = parseStoredReviewRecord(readReviewRecord(review.dir));
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
    ),
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
  return withReviewMutationLock(dir, () => reviewVcs.seal(dir, message));
}

export async function updateReviewPins(
  review: StoredReview,
  pins: Parameters<typeof updateReviewPinsLocked>[1],
): Promise<StoredReview> {
  return withReviewMutationLock(review.dir, async () => {
    await assertReviewUnchanged(review.dir, review.review);
    return updateReviewPinsLocked(
      {
        ...review,
        review: parseStoredReviewRecord(
          parseJsonText(
            await readFile(path.join(review.dir, "review.json"), "utf8"),
          ),
        ),
      },
      pins,
    );
  });
}

async function updateReviewPinsLocked(
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

export async function findReview(
  uuid: string,
  devHome?: string,
): Promise<StoredReview | null> {
  return findReviewRecord(uuid, devHome);
}

export async function findReviewForRepair(
  uuid: string,
  devHome?: string,
): Promise<StoredReview | null> {
  if (!UUID_PATTERN.test(uuid))
    throw new Error(`Review UUID is invalid: ${uuid}`);
  const dir = path.join(reviewsHomeDir(devHome), uuid);
  let value: JsonValue;
  try {
    const canonical = readReviewRecord(dir);
    if (canonical === null) return null;
    value = canonical;
  } catch (error) {
    if (isMissingFileError(error)) return null;
    const detail: ReviewHomeErrorDetail = {
      message: `Could not read review.json: ${errorMessage(error)}`,
    };
    const code =
      error instanceof Error && "code" in error
        ? z.string().safeParse(error.code)
        : null;
    if (code?.success) detail.code = code.data;
    throw new ReviewHomeScanError([reviewHomeError(dir, undefined, detail)]);
  }
  let review: StoredReviewRecord;
  try {
    review = parseAnyStoredReviewRecord(value);
  } catch (error) {
    throw new ReviewHomeScanError([
      reviewHomeError(dir, jsonObject(value), {
        code: "MIGRATION_REQUIRED",
        message: `Invalid review.json; run \`review migrate apply\`: ${errorMessage(error)}`,
      }),
    ]);
  }
  if (review.uuid !== uuid)
    throw new ReviewHomeScanError([
      reviewHomeError(dir, review, {
        message: "review.json UUID does not match its directory.",
      }),
    ]);
  return { dir, review };
}

/**
 * The one rule for "this UUID, in this checkout".
 *
 * Returns null for every out-of-scope answer — not found, bound elsewhere, already
 * terminal — and lets each caller decide between throwing and an empty result.
 */
export async function findScopedReview(
  uuid: string,
  scope: {
    worktreePath: string;
    /** Accepted and rejected reviews are out of scope unless asked for. */
    includeTerminal?: boolean;
    /** Repair must reach reviews whose review.json predates the current schema. */
    includeLegacySchema?: boolean;
    /** Override the default Review storage home. */
    devHome?: string;
  },
): Promise<StoredReview | null> {
  const found = await (
    scope.includeLegacySchema ? findReviewForRepair : findReview
  )(uuid, scope.devHome);
  if (!found) return null;
  const [storedRoot, requestedRoot] = await Promise.all(
    [found.review.worktreePath, scope.worktreePath].map((root) =>
      realpath(root).catch(() => path.resolve(root)),
    ),
  );
  if (storedRoot !== requestedRoot) return null;
  if (
    !scope.includeTerminal &&
    (found.review.status === "accepted" || found.review.status === "rejected")
  )
    return null;
  return found;
}

async function findReviewRecord(
  uuid: string,
  devHome?: string,
): Promise<StoredReview | null> {
  if (!UUID_PATTERN.test(uuid)) {
    throw new Error(`Review UUID is invalid: ${uuid}`);
  }
  const loaded = await readStoredReview(
    path.join(reviewsHomeDir(devHome), uuid),
  );
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
  options: {
    retentionDays?: DismissedRetentionDays;
    /** "read-only" copies the thread database instead of opening it in place. */
    threads?: "live" | "read-only";
  } = {},
): Promise<ReviewDescriptor> {
  // `null` is a real retention setting (never reap), so only an absent key defaults.
  const retentionDays =
    options.retentionDays === undefined
      ? DEFAULT_DISMISSED_RETENTION_DAYS
      : options.retentionDays;
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
  /* A read-only count that cannot be taken is a real failure, not zero comments:
     the caller decides whether to drop the descriptor. `countReviewComments` keeps
     its own documented zero for the live path. */
  const commentCount =
    options.threads === "read-only"
      ? Object.keys(readReviewThreadsReadOnly(documentPath).comments).length
      : documentExists
        ? countReviewComments(documentPath)
        : 0;
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
  let loaded: Array<StoredReview | { error: ReviewHomeError } | null>;
  try {
    const entries = await readdir(reviewsHomeDir(), { withFileTypes: true });
    loaded = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && UUID_PATTERN.test(entry.name))
        .map((entry) =>
          readReviewForList(path.join(reviewsHomeDir(), entry.name), filter),
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
    if (!entry) continue;
    if ("error" in entry) {
      result.errors.push(entry.error);
      continue;
    }
    if (!reviewMatchesFilter(entry.review, filter)) continue;
    const migrationError = reviewThreadMigrationError(entry);
    if (migrationError) result.errors.push(migrationError);
    result.reviews.push(entry);
  }
  return result;
}

async function readReviewForList(
  dir: string,
  filter: ListReviewsFilter,
): Promise<StoredReview | { error: ReviewHomeError } | null> {
  if (!filter.worktreePath && !filter.repoKey) return readStoredReview(dir);
  let record: JsonObject | undefined;
  try {
    record = jsonObject(readReviewRecord(dir));
  } catch {
    return unreadableReview(dir, filter);
  }
  const scope = {
    worktreePath: jsonString(record?.worktreePath),
    repoKey: jsonString(record?.repoKey),
  };
  // A record that cannot answer the scope question is not out of scope; the
  // strict read decides whether it becomes a list error.
  if (
    (filter.worktreePath && !scope.worktreePath) ||
    (filter.repoKey && !scope.repoKey)
  )
    return unreadableReview(dir, filter);
  return reviewMatchesFilter(scope, {
    worktreePath: filter.worktreePath,
    repoKey: filter.repoKey,
    includeSystem: true,
  })
    ? readStoredReview(dir)
    : null;
}

/** Every scope test in one place, so the canonical record pre-pass and the final
 * pass answer the same question about the same fields. */
function reviewMatchesFilter(
  record: {
    worktreePath?: string | undefined;
    repoKey?: string | undefined;
    status?: string | undefined;
    visibility?: string | undefined;
  },
  filter: ListReviewsFilter,
): boolean {
  if (!filter.includeSystem && record.visibility === "system") return false;
  if (
    filter.worktreePath &&
    (!record.worktreePath ||
      path.resolve(record.worktreePath) !== path.resolve(filter.worktreePath))
  )
    return false;
  if (filter.repoKey && record.repoKey !== filter.repoKey) return false;
  if (filter.status && record.status !== filter.status) return false;
  return true;
}

function unreadableReview(
  dir: string,
  filter: ListReviewsFilter,
): Promise<StoredReview | { error: ReviewHomeError }> | null {
  return filter.reportUnreadableReviews ? readStoredReview(dir) : null;
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
    let value = readReviewRecord(dir);
    let parsed = safeParseStoredReviewRecord(value);
    if (!parsed.success && isLegacyStoredReviewRecord(value, dir)) {
      try {
        await migrateLegacyStoredReview(dir);
      } catch (error) {
        if (error instanceof ReviewBusyError)
          return {
            error: reviewHomeError(dir, jsonObject(value), {
              code: error.code,
              message: error.message,
            }),
          };
        return {
          error: reviewHomeError(dir, jsonObject(value), {
            code: "REPAIR_REQUIRED",
            message: `${errorMessage(error)} Run \`review repair --review ${path.basename(dir)}\` to regenerate this Review's artifacts.`,
          }),
        };
      }
      value = readReviewRecord(dir);
      parsed = safeParseStoredReviewRecord(value);
    }
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

export async function persistStoredReviewRecord(
  dir: string,
  review: StoredReviewRecord,
  reviewHome?: string,
): Promise<void> {
  putReviewRecord(dir, review, reviewHome);
  await writePrivateJsonAtomic(path.join(dir, "review.json"), review);
}

function isLegacyStoredReviewRecord(value: JsonValue, dir: string): boolean {
  if (
    !isJsonObject(value) ||
    (value.schemaVersion !== 2 &&
      value.schemaVersion !== 3 &&
      value.schemaVersion !== 4)
  )
    return false;
  try {
    return parseAnyStoredReviewRecord(value).uuid === path.basename(dir);
  } catch {
    return false;
  }
}

async function migrateLegacyStoredReview(dir: string): Promise<void> {
  await withReviewMutationLock(dir, async () => {
    const current = parseJsonText(
      await readFile(path.join(dir, "review.json"), "utf8"),
    );
    if (!isLegacyStoredReviewRecord(current, dir)) return;
    const { migrateStoredReview } = await import("./stored-review-migration");
    const uuid = path.basename(dir);
    const outcome = await migrateStoredReview({
      reviewDir: dir,
      log: (message) => console.warn(`Review ${uuid}: ${message}`),
    });
    if (outcome.threadDbError)
      console.warn(
        `Review ${uuid}: thread database upgrade failed: ${outcome.threadDbError}`,
      );
  });
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

/** Schema 2 predates the required software map, so a schema-2 presentation may
 * legitimately have a document and no map. Every later schema must keep the
 * map it presents. */
const ABSENT_SOFTWARE_MAP_SCHEMA_VERSION = 2;

export function allowsAbsentSoftwareMap(record: {
  schemaVersion: number;
}): boolean {
  return record.schemaVersion === ABSENT_SOFTWARE_MAP_SCHEMA_VERSION;
}

/**
 * Parses a stored review at any schema version this build understands, upgrading legacy
 * records in memory. Nothing on disk changes. Every result is validated against the current
 * strict schema, so an unknown version or an unexpected key still throws.
 *
 * Use this wherever a review.json may predate the current schema (recovery, repair,
 * migration, historical revisions). Use `parseStoredReviewRecord` only where the record must
 * already be current — the sealed records the server itself just wrote.
 */
export function parseAnyStoredReviewRecord(
  value: JsonValue,
): StoredReviewRecord {
  if (!isJsonObject(value)) return parseStoredReviewRecord(value);
  const record = stripLegacySoftwareMap(value);
  if (record.schemaVersion === REVIEW_SCHEMA_VERSION)
    return parseStoredReviewRecord(record);
  const legacyRecord = LegacyStoredReviewRecordSchema.parse(record);
  if (legacyRecord.schemaVersion === 4) {
    return StoredReviewRecordSchema.parse({
      ...legacyRecord,
      schemaVersion: REVIEW_SCHEMA_VERSION,
    });
  }
  if (legacyRecord.schemaVersion === 3) {
    const {
      agentSession,
      schemaVersion: _schemaVersion,
      ...current
    } = legacyRecord;
    return StoredReviewRecordSchema.parse({
      ...current,
      schemaVersion: REVIEW_SCHEMA_VERSION,
      sourceSession: current.sourceSession ?? agentSession,
    });
  }
  const {
    agentSession,
    presentedRevision,
    schemaVersion: _schemaVersion,
    ...current
  } = legacyRecord;
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
