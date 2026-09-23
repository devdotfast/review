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
  errorMessage,
  withFileLock,
  writePrivateJsonAtomic,
} from "@dev.fast/trace-core";
import {
  DEFAULT_DISMISSED_RETENTION_DAYS,
  type JsonObject,
  type JsonValue,
  WHITEBOARD_SCHEMA_VERSION,
  type WhiteboardAgentSessionRole,
  type WhiteboardSourceIdentity,
  isJsonObject,
  jsonObject,
  jsonString,
  parseJsonText,
  summarizeWhiteboardDiffFiles,
} from "@dev.fast/whiteboard-protocol";
import { z } from "zod";

import {
  type SessionRef,
  authoringSessionKey,
  parseAuthoringSessionKey,
} from "./agent-session-ref";
import { isMissingFileError } from "./fs-utils";
import { resolveWhiteboardRepositoryIdentity } from "./repository-identity";
import {
  type WhiteboardRecord,
  WhiteboardRecordSchema,
} from "./review-import/legacy-record";
import {
  type DismissedRetentionDays,
  whiteboardReapsAt,
} from "./whiteboard-attention";
import { resolveWhiteboardDiffFiles } from "./whiteboard-diff-files";
import { devWhiteboardHome } from "./whiteboard-home-paths";
import {
  WhiteboardBusyError,
  withWhiteboardMutationLock,
} from "./whiteboard-mutation-lock";
import { whiteboardVcs } from "./whiteboard-vcs";

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CreateWhiteboardDirBinding {
  uuid?: string;
  reviewsHomePath?: string;
  visibility?: "system";
  worktreePath: string;
  baseRef: string;
  baseCommit: string;
  sourceCommit?: string | null;
  sourceIdentity?: WhiteboardSourceIdentity | null;
  pullRequestNumber?: number | null;
  pullRequestUrl?: string | null;
  title?: string;
  sourceSession?: string;
}

export const DISABLED_WHITEBOARD_SOURCE_SESSION = "disabled:review";

export const StoredWhiteboardRecordSchema = WhiteboardRecordSchema;

export type StoredWhiteboardRecord = WhiteboardRecord;

const legacyStoredSourceSessionFields = {
  sourceSession: z.string().min(1).optional(),
  agentSession: z.string().min(1).optional(),
};

const legacyStoredWhiteboardRecordFields = StoredWhiteboardRecordSchema.omit({
  schemaVersion: true,
  sourceSession: true,
});

const LegacyStoredWhiteboardRecordSchema = z
  .union([
    StoredWhiteboardRecordSchema.extend({ schemaVersion: z.literal(4) }),
    legacyStoredWhiteboardRecordFields.extend({
      schemaVersion: z.literal(3),
      ...legacyStoredSourceSessionFields,
    }),
    legacyStoredWhiteboardRecordFields
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

export interface StoredWhiteboard {
  dir: string;
  review: StoredWhiteboardRecord;
}

export interface ListWhiteboardsFilter {
  worktreePath?: string;
  repoKey?: string;
  status?: WhiteboardRecord["status"];
  includeSystem?: boolean;
  /** Surface a review whose review.json cannot be read, instead of skipping it. */
  reportUnreadableWhiteboards?: boolean;
}

export interface WhiteboardHomeError {
  whiteboardDir: string;
  sessionId: string | null;
  title: string;
  worktreePath: string;
  lastPublishedAt: string | null;
  message: string;
  code?: string;
}

export interface ListWhiteboardsResult {
  reviews: StoredWhiteboard[];
  errors: WhiteboardHomeError[];
}

export class WhiteboardHomeScanError extends Error {
  override readonly name = "WhiteboardHomeScanError";

  constructor(readonly errors: readonly WhiteboardHomeError[]) {
    super(
      `Could not read reviews:\n${errors.map((error) => `${error.whiteboardDir}: ${error.message}`).join("\n")}`,
    );
  }
}

export function reviewsHomeDir(devHome = devWhiteboardHome()): string {
  return path.join(devHome, "reviews");
}

export async function createWhiteboardDir(
  binding: CreateWhiteboardDirBinding,
): Promise<StoredWhiteboard> {
  const uuid = binding.uuid ?? createWhiteboardUuid();

  if (!UUID_PATTERN.test(uuid)) {
    throw new Error(`Session UUID is invalid: ${uuid}`);
  }

  const dir = path.join(reviewsHomeDir(binding.reviewsHomePath), uuid);
  const worktreePath = path.resolve(binding.worktreePath);
  const repository = await resolveWhiteboardRepositoryIdentity(worktreePath);
  const createdAt = new Date().toISOString();

  const sourceSession =
    binding.sourceSession ?? DISABLED_WHITEBOARD_SOURCE_SESSION;

  const attributedAgentSession = parseAuthoringSessionKey(sourceSession)
    ? sourceSession
    : null;

  const review: StoredWhiteboardRecord = {
    schemaVersion: WHITEBOARD_SCHEMA_VERSION,
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

  await mkdirWhiteboardDir(dir);

  try {
    await whiteboardVcs.init(dir);
    await Promise.all([
      writeFile(
        path.join(dir, "review.mdx"),
        defaultWhiteboardMdx(review),
        "utf8",
      ),
      writeFile(path.join(dir, "data.ts"), "export {};\n", "utf8"),
      writeFile(
        path.join(dir, "package.json"),
        `${JSON.stringify(whiteboardPackageJson(uuid), null, 2)}\n`,
        "utf8",
      ),
      writeFile(path.join(dir, ".gitignore"), whiteboardGitignore, "utf8"),
    ]);
    await writePrivateJsonAtomic(path.join(dir, "review.json"), review);
  } catch (error) {
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

export async function touchWhiteboardAgentSession(
  review: StoredWhiteboard,
  sessionKey: string,
  role: WhiteboardAgentSessionRole,
  now = new Date().toISOString(),
): Promise<StoredWhiteboard> {
  if (!parseAuthoringSessionKey(sessionKey)) {
    throw new Error(`Agent session key is invalid: ${sessionKey}`);
  }

  const recordPath = path.join(review.dir, "review.json");

  const outcome = await withWhiteboardMutationLock(review.dir, () =>
    withFileLock(
      path.join(review.dir, ".agent-sessions.lock"),
      AGENT_SESSION_LOCK_OPTIONS,
      async () => {
        const current = parseStoredWhiteboardRecord(
          JSON.parse(await readFile(recordPath, "utf8")),
        );

        const prior = current.agentSessions?.[sessionKey];

        const roles = prior?.roles.includes(role)
          ? prior.roles
          : [...(prior?.roles ?? []), role];

        const updated: StoredWhiteboardRecord = {
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

        await writePrivateJsonAtomic(recordPath, updated);

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

export async function sealWhiteboardCandidate(
  dir: string,
  message: string,
): Promise<string> {
  return withWhiteboardMutationLock(dir, () =>
    whiteboardVcs.seal(dir, message),
  );
}

export function createWhiteboardUuid(): string {
  return randomUUID();
}

/** The document's first ATX H1, used as the Review display title. */
export async function whiteboardTitleFromDocument(
  documentPath: string,
): Promise<string | undefined> {
  const document = await readFile(documentPath, "utf8");

  for (const line of document.split(/\r?\n/)) {
    const heading = /^#\s+(.+?)\s*#*\s*$/.exec(line);

    if (heading) return heading[1].trim() || undefined;
  }

  return undefined;
}

export async function findWhiteboard(
  uuid: string,
  devHome?: string,
): Promise<StoredWhiteboard | null> {
  return findWhiteboardRecord(uuid, devHome);
}

export async function findWhiteboardForRepair(
  uuid: string,
  devHome?: string,
): Promise<StoredWhiteboard | null> {
  if (!UUID_PATTERN.test(uuid))
    throw new Error(`Session UUID is invalid: ${uuid}`);
  const dir = path.join(reviewsHomeDir(devHome), uuid);
  let value: JsonValue;

  try {
    value = parseJsonText(
      await readFile(path.join(dir, "review.json"), "utf8"),
    );
  } catch (error) {
    if (isMissingFileError(error)) return null;

    const detail: WhiteboardHomeErrorDetail = {
      message: `Could not read review.json: ${errorMessage(error)}`,
    };

    const code =
      error instanceof Error && "code" in error
        ? z.string().safeParse(error.code)
        : null;

    if (code?.success) detail.code = code.data;
    throw new WhiteboardHomeScanError([
      whiteboardHomeError(dir, undefined, detail),
    ]);
  }

  let review: StoredWhiteboardRecord;

  try {
    review = parseAnyStoredWhiteboardRecord(value);
  } catch (error) {
    throw new WhiteboardHomeScanError([
      whiteboardHomeError(dir, jsonObject(value), {
        code: "MIGRATION_REQUIRED",
        message: `Invalid review.json; run \`whiteboard migrate apply\`: ${errorMessage(error)}`,
      }),
    ]);
  }

  if (review.uuid !== uuid)
    throw new WhiteboardHomeScanError([
      whiteboardHomeError(dir, review, {
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
export async function findScopedWhiteboard(
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
): Promise<StoredWhiteboard | null> {
  const found = await (
    scope.includeLegacySchema ? findWhiteboardForRepair : findWhiteboard
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

async function findWhiteboardRecord(
  uuid: string,
  devHome?: string,
): Promise<StoredWhiteboard | null> {
  if (!UUID_PATTERN.test(uuid)) {
    throw new Error(`Session UUID is invalid: ${uuid}`);
  }

  const loaded = await readStoredWhiteboard(
    path.join(reviewsHomeDir(devHome), uuid),
  );

  if ("error" in loaded) {
    if (loaded.error.code === "ENOENT") return null;
    throw new WhiteboardHomeScanError([loaded.error]);
  }

  if (loaded.review.uuid !== uuid) {
    throw new WhiteboardHomeScanError([
      whiteboardHomeError(loaded.dir, loaded.review, {
        message: "review.json UUID does not match its directory.",
      }),
    ]);
  }

  return loaded;
}

export async function whiteboardDescriptor(
  stored: StoredWhiteboard,
  options: {
    retentionDays?: DismissedRetentionDays;
  } = {},
) {
  // `null` is a real retention setting (never reap), so only an absent key defaults.
  const retentionDays =
    options.retentionDays === undefined
      ? DEFAULT_DISMISSED_RETENTION_DAYS
      : options.retentionDays;

  const documentPath = path.join(stored.dir, "review.mdx");

  const [whiteboardDirExists, worktreeExists, documentStats] =
    await Promise.all([
      pathExists(stored.dir),
      pathExists(stored.review.worktreePath),
      statIfExists(documentPath),
    ]);

  const documentExists = documentStats !== null;
  const available = whiteboardDirExists && worktreeExists && documentExists;
  /* Same diff target as the review document (resolveRequestDiffTarget):
     the pinned baseCommit..sourceCommit from review.json. An empty diff
     reports null so the views omit the numbers, as the document does. */
  const headCommit = stored.review.sourceCommit ?? stored.review.baseCommit;

  const [diffStats, commits] = await Promise.all([
    worktreeExists && stored.review.sourceCommit
      ? resolveWhiteboardDiffFiles({
          rootPath: stored.review.worktreePath,
          baseRef: stored.review.baseCommit,
          headRef: stored.review.sourceCommit,
          includePatch: false,
        })
          .then(({ files }) =>
            files.length ? summarizeWhiteboardDiffFiles(files) : null,
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
    documentUpdatedAt: documentStats?.mtime.toISOString() ?? null,
    presentedDocumentRevision: stored.review.presentedDocumentRevision,
    presentedSoftwareMapRevision: stored.review.presentedSoftwareMapRevision,
    lastPublishedAt: stored.review.lastPublishedAt,
    available,
    viewedAt: stored.review.viewedAt ?? null,
    dismissedAt: stored.review.dismissedAt ?? null,
    reapsAt: whiteboardReapsAt(stored.review, retentionDays),
  };
}

export async function listWhiteboards(
  filter: ListWhiteboardsFilter = {},
): Promise<ListWhiteboardsResult> {
  let loaded: Array<StoredWhiteboard | { error: WhiteboardHomeError } | null>;

  try {
    const entries = await readdir(reviewsHomeDir(), { withFileTypes: true });
    loaded = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && UUID_PATTERN.test(entry.name))
        .map((entry) =>
          readWhiteboardForList(
            path.join(reviewsHomeDir(), entry.name),
            filter,
          ),
        ),
    );
  } catch (error) {
    if (isMissingFileError(error)) {
      return { reviews: [], errors: [] };
    }

    throw error;
  }

  const result: ListWhiteboardsResult = { reviews: [], errors: [] };

  for (const entry of loaded) {
    if (!entry) continue;

    if ("error" in entry) {
      result.errors.push(entry.error);
      continue;
    }

    if (!whiteboardMatchesFilter(entry.review, filter)) continue;
    result.reviews.push(entry);
  }

  return result;
}

async function readWhiteboardForList(
  dir: string,
  filter: ListWhiteboardsFilter,
): Promise<StoredWhiteboard | { error: WhiteboardHomeError } | null> {
  if (!filter.worktreePath && !filter.repoKey) return readStoredWhiteboard(dir);
  let record: JsonObject | undefined;

  try {
    record = jsonObject(
      parseJsonText(await readFile(path.join(dir, "review.json"), "utf8")),
    );
  } catch {
    return unreadableWhiteboard(dir, filter);
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
    return unreadableWhiteboard(dir, filter);

  return whiteboardMatchesFilter(scope, {
    worktreePath: filter.worktreePath,
    repoKey: filter.repoKey,
    includeSystem: true,
  })
    ? readStoredWhiteboard(dir)
    : null;
}

/** Every scope test in one place, so the cheap JSON pre-pass and the final
 * pass answer the same question about the same fields. */
function whiteboardMatchesFilter(
  record: {
    worktreePath?: string | undefined;
    repoKey?: string | undefined;
    status?: string | undefined;
    visibility?: string | undefined;
  },
  filter: ListWhiteboardsFilter,
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

function unreadableWhiteboard(
  dir: string,
  filter: ListWhiteboardsFilter,
): Promise<StoredWhiteboard | { error: WhiteboardHomeError }> | null {
  return filter.reportUnreadableWhiteboards ? readStoredWhiteboard(dir) : null;
}

export async function computeSync(
  review: WhiteboardRecord,
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

async function mkdirWhiteboardDir(dir: string): Promise<void> {
  await mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });

  try {
    await mkdir(dir, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`Session directory already exists: ${dir}`);
    }

    throw error;
  }
}

export async function materializeWhiteboardRevision(
  dir: string,
  revision: string,
  destinationPath: string,
): Promise<void> {
  const resolvedRevision = await whiteboardVcs.resolve(dir, revision);
  await whiteboardVcs.materialize(dir, resolvedRevision, destinationPath);
}

export async function readStoredWhiteboard(
  dir: string,
): Promise<StoredWhiteboard | { error: WhiteboardHomeError }> {
  const whiteboardPath = path.join(dir, "review.json");

  try {
    let value = parseJsonText(await readFile(whiteboardPath, "utf8"));
    let parsed = safeParseStoredWhiteboardRecord(value);

    if (!parsed.success && isLegacyStoredWhiteboardRecord(value, dir)) {
      try {
        await migrateLegacyStoredWhiteboard(dir);
      } catch (error) {
        if (error instanceof WhiteboardBusyError)
          return {
            error: whiteboardHomeError(dir, jsonObject(value), {
              code: error.code,
              message: error.message,
            }),
          };

        return {
          error: whiteboardHomeError(dir, jsonObject(value), {
            code: "REPAIR_REQUIRED",
            message: `${errorMessage(error)} This review was published with the removed MDX toolchain and its stored files are damaged, so it cannot be imported. Delete it from Home and recreate it with the Review skill.`,
          }),
        };
      }

      value = parseJsonText(await readFile(whiteboardPath, "utf8"));
      parsed = safeParseStoredWhiteboardRecord(value);
    }

    if (!parsed.success) {
      return {
        error: whiteboardHomeError(dir, jsonObject(value), {
          message: `Invalid review.json; run \`whiteboard migrate apply\`: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
          code: "MIGRATION_REQUIRED",
        }),
      };
    }

    return { dir, review: parsed.data };
  } catch (error) {
    const detail: WhiteboardHomeErrorDetail = {
      message: `Could not read review.json: ${error instanceof Error ? error.message : String(error)}`,
    };

    // SAFETY: the try block only throws fs ErrnoExceptions and JSON
    // SyntaxErrors; `code` is the errno name on the former and absent on the
    // latter.
    const code = (error as NodeJS.ErrnoException).code;

    if (code) detail.code = code;

    return { error: whiteboardHomeError(dir, undefined, detail) };
  }
}

function isLegacyStoredWhiteboardRecord(
  value: JsonValue,
  dir: string,
): boolean {
  if (
    !isJsonObject(value) ||
    (value.schemaVersion !== 2 &&
      value.schemaVersion !== 3 &&
      value.schemaVersion !== 4)
  )
    return false;

  try {
    return parseAnyStoredWhiteboardRecord(value).uuid === path.basename(dir);
  } catch {
    return false;
  }
}

async function migrateLegacyStoredWhiteboard(dir: string): Promise<void> {
  await withWhiteboardMutationLock(dir, async () => {
    const current = parseJsonText(
      await readFile(path.join(dir, "review.json"), "utf8"),
    );

    if (!isLegacyStoredWhiteboardRecord(current, dir)) return;

    const { migrateStoredWhiteboard } =
      await import("./stored-review-migration");

    const uuid = path.basename(dir);

    await migrateStoredWhiteboard({
      whiteboardDir: dir,
      log: (message) => console.warn(`Review ${uuid}: ${message}`),
    });
  });
}

/** `record` is the parsed review, or the raw review.json object when it failed to parse. */
interface WhiteboardHomeErrorDetail {
  message: string;
  code?: string;
}

function whiteboardHomeError(
  whiteboardDir: string,
  record: StoredWhiteboardRecord | JsonObject | undefined,
  error: WhiteboardHomeErrorDetail,
): WhiteboardHomeError {
  const directoryUuid = path.basename(whiteboardDir);
  const storedUuid = jsonString(record?.uuid) ?? null;

  const sessionId = UUID_PATTERN.test(storedUuid ?? "")
    ? storedUuid
    : UUID_PATTERN.test(directoryUuid)
      ? directoryUuid
      : null;

  const result: WhiteboardHomeError = {
    whiteboardDir,
    sessionId,
    title: jsonString(record?.title) ?? "",
    worktreePath: jsonString(record?.worktreePath) || whiteboardDir,
    lastPublishedAt: jsonString(record?.lastPublishedAt) ?? null,
    message: error.message,
  };

  if (error.code) result.code = error.code;

  return result;
}

export function parseStoredWhiteboardRecord(
  value: JsonValue,
): StoredWhiteboardRecord {
  return StoredWhiteboardRecordSchema.parse(stripLegacySoftwareMap(value));
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
 * migration, historical revisions). Use `parseStoredWhiteboardRecord` only where the record must
 * already be current — the sealed records the server itself just wrote.
 */
export function parseAnyStoredWhiteboardRecord(
  value: JsonValue,
): StoredWhiteboardRecord {
  if (!isJsonObject(value)) return parseStoredWhiteboardRecord(value);
  const record = stripLegacySoftwareMap(value);

  if (record.schemaVersion === WHITEBOARD_SCHEMA_VERSION)
    return parseStoredWhiteboardRecord(record);
  const legacyRecord = LegacyStoredWhiteboardRecordSchema.parse(record);

  if (legacyRecord.schemaVersion === 4) {
    return StoredWhiteboardRecordSchema.parse({
      ...legacyRecord,
      schemaVersion: WHITEBOARD_SCHEMA_VERSION,
    });
  }

  if (legacyRecord.schemaVersion === 3) {
    const {
      agentSession,
      schemaVersion: _schemaVersion,
      ...current
    } = legacyRecord;

    return StoredWhiteboardRecordSchema.parse({
      ...current,
      schemaVersion: WHITEBOARD_SCHEMA_VERSION,
      sourceSession: current.sourceSession ?? agentSession,
    });
  }

  const {
    agentSession,
    presentedRevision,
    schemaVersion: _schemaVersion,
    ...current
  } = legacyRecord;

  return StoredWhiteboardRecordSchema.parse({
    ...current,
    schemaVersion: WHITEBOARD_SCHEMA_VERSION,
    sourceSession: current.sourceSession ?? agentSession,
    presentedDocumentRevision: presentedRevision ?? null,
    presentedSoftwareMapRevision: presentedRevision ?? null,
  });
}

export function safeParseStoredWhiteboardRecord(value: JsonValue) {
  return StoredWhiteboardRecordSchema.safeParse(stripLegacySoftwareMap(value));
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

function defaultWhiteboardMdx(review: WhiteboardRecord): string {
  return `# ${review.title}\n\nThis review document is ready for repo-specific notes.\n\n{/* Review source: ${review.sourceCommit ?? "unbound"} */}\n`;
}

function whiteboardPackageJson(uuid: string) {
  return {
    name: `review-${uuid}`,
    private: true,
    type: "module",
  };
}

// Keep build output and any review.db left by older versions (and sqlite's
// transient sidecars) out of the review VCS: sealed revisions would otherwise
// capture nondeterministic binary state.
const whiteboardGitignore = [
  ".build/",
  "review.db",
  "review.db-wal",
  "review.db-shm",
  "",
].join("\n");
