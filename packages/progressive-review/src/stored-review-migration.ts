import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  type JsonObject,
  REVIEW_SCHEMA_VERSION,
  jsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";
import { z } from "zod";

import {
  authoringSessionKey,
  parseAuthoringSessionKey,
} from "./authoring-session";
import { errorMessage } from "./error-message";
import {
  type PlanLegacyReviewArtifactImportInput,
  commitLegacyReviewArtifactImport,
  planLegacyReviewArtifactImport,
} from "./legacy-review-import";
import { isMissingFileError } from "./native-agent/transcript-json";
import { createLegacyCodeRecordMigrator } from "./review-code-target-migration";
import {
  ensureReviewPinnedCheckout,
  removeLegacyReviewCheckouts,
} from "./review-head-checkout";
import {
  type StoredReviewRecord,
  parseAnyStoredReviewRecord,
} from "./review-home";
import { withReviewMutationLock } from "./review-mutation-lock";
import { createReviewSourceAgentSession } from "./review-source-agent-session";
import { importLegacyReview, readReviewRecord } from "./review-state-db";
import {
  type ReviewThreadDbMigrationOptions,
  migrateReviewThreadDb,
} from "./review-thread-store-backend";
import { writePrivateJsonAtomic } from "./server/desktop-paths";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StoredReviewMigrationResult extends DroppedLegacyReviewState {
  failedReviewUuids?: string[];
  documents: number;
  droppedLegacyPeekReviews: number;
  droppedReviews: number;
  legacyCheckoutsRemoved: number;
  upgradedThreadDatabases: number;
  /** Document versions replayed out of private Git histories into rows. */
  importedVersions: number;
  /** Imported versions whose sealed bytes could not be converted. */
  unavailableVersions: number;
}

interface DroppedLegacyReviewState {
  droppedComments: number;
  droppedQuestions: number;
}

export interface StoredReviewMigrationOutcome {
  record: StoredReviewRecord;
  /** True when the artifact import committed a new record for this review. */
  migrated: boolean;
  upgradedThreadDb: boolean;
  threadDbError?: string;
  importedVersions: number;
  unavailableVersions: number;
  warnings: string[];
}

interface StoredReviewMigrationInput {
  reviewDir: string;
  log?: (message: string) => void;
  createSourceSession?: typeof createReviewSourceAgentSession;
  force?: boolean;
  onDropLegacyCodeRecord?: ReviewThreadDbMigrationOptions["onDropLegacyCodeRecord"];
}

/** One review: record normalization, thread DB upgrade, and the import that
 * replays its private Git publications as artifact publication rows. Shared by
 * the CLI sweep and the store loader. Repo-level cleanup (legacy checkouts,
 * `repos/`) stays in the sweep. */
export async function migrateStoredReview(
  input: StoredReviewMigrationInput,
): Promise<StoredReviewMigrationOutcome> {
  return withReviewMutationLock(input.reviewDir, () =>
    migrateStoredReviewLocked(input),
  );
}

async function migrateStoredReviewLocked(
  input: StoredReviewMigrationInput,
): Promise<StoredReviewMigrationOutcome> {
  const reviewPath = path.join(input.reviewDir, "review.mdx");
  // Read-only: a not-yet-migrated legacy record must not be imported into
  // the database until migration actually commits a result for it.
  const value = jsonObject(
    readReviewRecord(input.reviewDir, undefined, { importMirror: false }),
  );
  const schemaVersion = value?.schemaVersion;
  if (
    !value ||
    ![2, 3, 4, 5, REVIEW_SCHEMA_VERSION].includes(Number(schemaVersion))
  ) {
    throw new Error("Unsupported Review schema; the record was preserved.");
  }
  const record = parseAnyStoredReviewRecord(value);
  if (record.uuid !== path.basename(input.reviewDir))
    throw new Error("review.json UUID does not match its directory");
  const legacySourceSession = schemaVersion === 2 || schemaVersion === 3;

  // `importLegacyReview` refuses a per-review thread database at an older
  // schema, and the artifact import runs it first, so the thread database has
  // to move before anything is planned.
  const droppedRecords: Array<
    Parameters<
      NonNullable<ReviewThreadDbMigrationOptions["onDropLegacyCodeRecord"]>
    >[0]
  > = [];
  const threadDbMigration: ReviewThreadDbMigrationOptions = {
    force: input.force ?? false,
    preserveLegacyQuestions: true,
    onDropLegacyCodeRecord: (dropped) => droppedRecords.push(dropped),
  };
  if (record.sourceCommit) {
    threadDbMigration.migrateLegacyCodeRecord = createLegacyCodeRecordMigrator({
      rootPath: record.worktreePath,
      baseCommit: record.baseCommit,
      headCommit: record.sourceCommit,
    });
  }
  let upgradedThreadDb = false;
  let threadDbError: string | undefined;
  try {
    upgradedThreadDb =
      (await migrateReviewThreadDb(reviewPath, threadDbMigration)) ===
      "upgraded";
    importLegacyReview(input.reviewDir);
  } catch (error) {
    threadDbError = errorMessage(error);
  }
  if (upgradedThreadDb)
    for (const dropped of droppedRecords)
      input.onDropLegacyCodeRecord?.(dropped);
  if (threadDbError) {
    // The import cannot run over an unmigrated thread database, and bumping
    // the record without it would leave a schema-6 review whose pointer no
    // publication row answers. Preserve the record exactly as stored.
    return {
      record,
      migrated: false,
      upgradedThreadDb,
      threadDbError,
      importedVersions: 0,
      unavailableVersions: 0,
      warnings: [],
    };
  }

  const planInput: PlanLegacyReviewArtifactImportInput = {
    reviewDir: input.reviewDir,
    record,
    original: value,
  };
  if (input.log) planInput.warn = input.log;
  const plan = await planLegacyReviewArtifactImport(planInput);
  if ("imported" in plan)
    return {
      record,
      migrated: false,
      upgradedThreadDb,
      importedVersions: 0,
      unavailableVersions: 0,
      warnings: [],
    };
  // Schema 2 and 3 also fork a frozen native source session. Forking is an
  // externally visible side effect, so it happens only once the plan proves
  // the sealed history converts: a refused import creates no fork.
  const next = legacySourceSession
    ? await migratedSourceSessionRecord(input, value, plan.next)
    : plan.next;
  const imported = await commitLegacyReviewArtifactImport(input.reviewDir, {
    ...plan,
    next,
  });
  if (legacySourceSession) await clearSourceMigrationState(input);
  input.log?.(
    `Migrated Review ${imported.uuid} to schema ${REVIEW_SCHEMA_VERSION} with ${plan.versions} imported version(s).`,
  );
  return {
    record: imported,
    migrated: true,
    upgradedThreadDb,
    importedVersions: plan.versions,
    unavailableVersions: plan.unavailable,
    warnings: plan.warnings,
  };
}

/** Schema 2 and 3 bound the authoring agent by an alias; the record they
 * migrate to names a frozen native source session instead. */
async function migratedSourceSessionRecord(
  input: StoredReviewMigrationInput,
  value: JsonObject,
  next: StoredReviewRecord,
): Promise<StoredReviewRecord> {
  const migrated = await migratePendingReviewSourceSession({
    reviewDir: input.reviewDir,
    value,
    createSourceSession:
      input.createSourceSession ?? createReviewSourceAgentSession,
    onWarning: input.log,
  });
  // Both halves are already validated records, so the graft cannot invalidate
  // the result; only the session binding moves across.
  return {
    ...next,
    sourceSession: migrated.sourceSession,
    agentSessions: migrated.agentSessions,
  };
}

async function clearSourceMigrationState(
  input: StoredReviewMigrationInput,
): Promise<void> {
  try {
    await rm(sourceMigrationStatePath(input.reviewDir), { force: true });
  } catch (error) {
    input.log?.(
      `Review source binding migrated, but pending state cleanup failed: ${errorMessage(error)}`,
    );
  }
}

export async function migrateStoredReviewData(input: {
  reviewHome: string;
  force?: boolean;
  log?: (message: string) => void;
  onBlocker?: (message: string) => void;
}): Promise<StoredReviewMigrationResult> {
  await rm(path.join(input.reviewHome, "repos"), {
    recursive: true,
    force: true,
  });
  const total: StoredReviewMigrationResult = {
    failedReviewUuids: [],
    documents: 0,
    droppedComments: 0,
    droppedLegacyPeekReviews: 0,
    droppedQuestions: 0,
    droppedReviews: 0,
    legacyCheckoutsRemoved: 0,
    upgradedThreadDatabases: 0,
    importedVersions: 0,
    unavailableVersions: 0,
  };
  const reviewsRoot = path.join(input.reviewHome, "reviews");
  const cleanedLegacyRoots = new Set<string>();
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(reviewsRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) return total;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
    const reviewDir = path.join(reviewsRoot, entry.name);
    try {
      const outcome = await migrateStoredReview({
        reviewDir,
        log: input.log,
        force: input.force,
        onDropLegacyCodeRecord: ({ threadId, kind }) => {
          total.droppedComments += 1;
          input.log?.(
            `Dropped legacy ${kind} ${JSON.stringify(threadId)} from Review ${entry.name}.`,
          );
        },
      });
      const worktreePath = outcome.record.worktreePath;
      if (!cleanedLegacyRoots.has(worktreePath)) {
        cleanedLegacyRoots.add(worktreePath);
        total.legacyCheckoutsRemoved += await removeLegacyReviewCheckouts({
          rootPath: worktreePath,
          onBlocker: input.onBlocker,
        });
      }
      if (outcome.upgradedThreadDb) {
        total.upgradedThreadDatabases += 1;
        input.log?.(
          `Upgraded Review database ${entry.name} to the current schema.`,
        );
      }
      if (outcome.threadDbError)
        input.onBlocker?.(
          `Review ${entry.name} database migration failed: ${outcome.threadDbError}`,
        );
      for (const warning of outcome.warnings) input.onBlocker?.(warning);
      if (outcome.migrated) {
        total.importedVersions += outcome.importedVersions;
        total.unavailableVersions += outcome.unavailableVersions;
        if (outcome.importedVersions > 0)
          input.log?.(
            `Imported ${outcome.importedVersions} published version(s) of Review ${entry.name}.`,
          );
        // The private Git materialization cache is dead once the artifacts
        // and rows are committed; every read now serves from the store.
        await rm(path.join(reviewDir, ".build"), {
          recursive: true,
          force: true,
        });
      }
      total.documents += 1;
    } catch (error) {
      total.failedReviewUuids?.push(entry.name);
      const message = `${reviewDir}: current artifact migration failed: ${errorMessage(error)} Review preserved; retry review migrate apply after resolving the blocker.`;
      input.onBlocker?.(message);
      input.log?.(message);
    }
  }
  return total;
}

const sourceMigrationStateSchema = z.discriminatedUnion("state", [
  z.object({
    version: z.literal(1),
    key: z.string(),
    state: z.literal("started"),
  }),
  z.object({
    version: z.literal(1),
    key: z.string(),
    state: z.literal("ready"),
    sourceSession: z
      .string()
      .refine(
        (value) =>
          value === "disabled:review" ||
          parseAuthoringSessionKey(value) !== undefined,
      ),
    boundAt: z.iso.datetime(),
  }),
]);

function sourceMigrationStatePath(reviewDir: string): string {
  return `${reviewDir}.source-migration.json`;
}

async function migratePendingReviewSourceSession(input: {
  reviewDir: string;
  onWarning?: (message: string) => void;
  createSourceSession: typeof createReviewSourceAgentSession;
  value: JsonObject;
}): Promise<StoredReviewRecord> {
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        input.value.uuid,
        input.value.schemaVersion,
        input.value.agentSession,
        input.value.sourceIdentity,
        input.value.worktreePath,
        input.value.baseRef,
        input.value.baseCommit,
        input.value.sourceCommit,
        input.value.presentedDocumentRevision,
        input.value.presentedRevision,
        input.value.presentedSoftwareMapRevision,
      ]),
    )
    .digest("hex");
  const statePath = sourceMigrationStatePath(input.reviewDir);
  let pending: z.infer<typeof sourceMigrationStateSchema> | undefined;
  try {
    pending = sourceMigrationStateSchema.parse(
      parseJsonText(await readFile(statePath, "utf8")),
    );
  } catch (error) {
    if (!isMissingFileError(error))
      throw new Error(
        `Cannot read source migration binding ${statePath}. Inspect and recover this file before retrying; no new native fork was created.`,
        { cause: error },
      );
  }
  if (pending && pending.key !== key) {
    throw new Error(
      `Source migration binding ${statePath} belongs to different Review pins. Inspect and reconcile the pending binding before retrying; no new native fork was created.`,
    );
  }
  if (pending?.state === "started") {
    throw new Error(
      `Source migration binding ${statePath} was interrupted after starting a native fork. Inspect the native session and recover the pending binding before retrying; no new native fork was created.`,
    );
  }
  if (!pending) {
    await writePrivateJsonAtomic(statePath, {
      version: 1,
      key,
      state: "started",
    });
    const migrated = await migrateReviewSourceSession(input);
    pending = {
      version: 1,
      key,
      state: "ready",
      sourceSession: parseAnyStoredReviewRecord(migrated).sourceSession,
      boundAt: new Date().toISOString(),
    };
    await writePrivateJsonAtomic(statePath, pending);
  }
  const { agentSession: _agentSession, ...record } = input.value;
  const priorAgentSessions = jsonObject(record.agentSessions) ?? {};
  return parseAnyStoredReviewRecord({
    ...record,
    sourceSession: pending.sourceSession,
    agentSessions:
      pending.sourceSession === "disabled:review"
        ? priorAgentSessions
        : {
            ...priorAgentSessions,
            [pending.sourceSession]: {
              firstSeenAt: pending.boundAt,
              lastSeenAt: pending.boundAt,
              roles: ["author"],
            },
          },
  });
}

async function migrateReviewSourceSession(input: {
  onWarning?: (message: string) => void;
  createSourceSession: typeof createReviewSourceAgentSession;
  value: JsonObject;
}): Promise<JsonObject> {
  const source = parseAuthoringSessionKey(jsonString(input.value.agentSession));
  const uuid = jsonString(input.value.uuid) ?? null;
  const worktreePath = jsonString(input.value.worktreePath) ?? null;
  const sourceCommit = jsonString(input.value.sourceCommit) ?? null;
  const { agentSession: _agentSession, ...record } = input.value;
  if (!source || !uuid || !worktreePath || !sourceCommit) {
    input.onWarning?.(
      `Review ${uuid ?? "with unknown UUID"} has no usable authoring session. Ask Agent is disabled, but the Review was preserved.`,
    );
    return { ...record, sourceSession: "disabled:review" };
  }
  try {
    const checkout = await ensureReviewPinnedCheckout({
      rootPath: worktreePath,
      ref: sourceCommit,
      reviewUuid: uuid,
      role: "head",
    });
    if (!checkout) {
      throw new Error("the pinned head checkout is unavailable");
    }
    const frozen = await input.createSourceSession({
      agent: source,
      reviewUuid: uuid,
      rootPath: checkout,
    });
    const sourceSession = authoringSessionKey(frozen);
    const now = new Date().toISOString();
    const priorAgentSessions = jsonObject(record.agentSessions) ?? {};
    return {
      ...record,
      agentSessions: {
        ...priorAgentSessions,
        [sourceSession]: {
          firstSeenAt: now,
          lastSeenAt: now,
          roles: ["author"],
        },
      },
      sourceSession,
    };
  } catch (error) {
    input.onWarning?.(
      `Review ${uuid} source session migration failed: ${errorMessage(error)}. Ask Agent is disabled, but the Review was preserved.`,
    );
  }
  return {
    ...record,
    sourceSession: "disabled:review",
  };
}
