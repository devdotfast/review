import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  type JsonObject,
  REVIEW_SCHEMA_VERSION,
  jsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";
import type { Node as EstreeNode } from "estree";

import {
  authoringSessionKey,
  parseAuthoringSessionKey,
} from "./authoring-session";
import { errorMessage } from "./error-message";
import { isMissingFileError } from "./native-agent/transcript-json";
import {
  bundleReviewDocument,
  readReviewDocumentBundle,
  writeReviewDocumentBundle,
} from "./review-bundle";
import { createLegacyCodeRecordMigrator } from "./review-code-target-migration";
import { maskReviewFrontmatter } from "./review-frontmatter";
import {
  ensureReviewPinnedCheckout,
  removeLegacyReviewCheckouts,
} from "./review-head-checkout";
import {
  type StoredReviewRecord,
  materializeReviewRevision,
  parseStoredReviewRecord,
  parseStoredReviewRecordForMigration,
  sealReviewCandidate,
} from "./review-home";
import { findCallExpressions, parseReviewMdxDocument } from "./review-mdx-ast";
import { withReviewMutationLock } from "./review-mutation-lock";
import { evaluateReviewDocumentBundleForPublish } from "./review-publish-evaluate";
import { createReviewSourceAgentSession } from "./review-source-agent-session";
import {
  type ReviewThreadDbMigrationOptions,
  migrateReviewThreadDb,
} from "./review-thread-store-backend";
import { writePrivateJsonAtomic } from "./server/desktop-paths";
import {
  type ReviewSoftwareMapBundle,
  bundleReviewSoftwareMap,
  readReviewSoftwareMapBundle,
  writeReviewSoftwareMapBundle,
} from "./software-map-bundle";
import {
  type NormalizedSoftwareModel,
  isNormalizedSoftwareModel,
} from "./software-map-model";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StoredReviewMigrationResult extends DroppedLegacyReviewState {
  failedReviewUuids?: string[];
  documents: number;
  droppedLegacyPeekReviews: number;
  droppedReviews: number;
  legacyCheckoutsRemoved: number;
  upgradedThreadDatabases: number;
}

interface DroppedLegacyReviewState {
  droppedComments: number;
  droppedQuestions: number;
}

const REVIEW_AUTHORING_MODULE_ID = "virtual:progressive-review-authoring";
const LEGACY_REVIEW_AUTHORING_MODULE_ID = "@dev.fast/review/authoring";
const LEGACY_IMPLICIT_AUTHORING_HELPERS = [
  "defineActors",
  "defineAnchors",
  "defineSoftwareActors",
  "defineSoftwareModel",
  "defineSoftwareStores",
  "defineStores",
] as const;

export interface StoredReviewDocumentMigrationIssue {
  code:
    | "STANDARD_MDX_PARSE_ERROR"
    | "LEGACY_AUTHORING_IMPORT"
    | "IMPLICIT_AUTHORING_HELPER";
  filePath: string;
  line: number;
  message: string;
}

export interface StoredReviewDocumentAuditResult {
  documents: number;
  issues: StoredReviewDocumentMigrationIssue[];
}

export async function auditStoredReviewDocuments(input: {
  reviewHome: string;
  skipReviewUuids?: readonly string[];
  onlyUnpresented?: boolean;
}): Promise<StoredReviewDocumentAuditResult> {
  const reviewPaths = await listStoredReviewDocuments(input.reviewHome, input);
  const issues = (
    await Promise.all(
      reviewPaths.map(async (reviewPath) =>
        auditStoredReviewDocument(
          reviewPath,
          await readFile(reviewPath, "utf8"),
        ),
      ),
    )
  ).flat();
  return { documents: reviewPaths.length, issues };
}

export function auditStoredReviewDocument(
  filePath: string,
  source: string,
): StoredReviewDocumentMigrationIssue[] {
  const maskedSource = maskReviewFrontmatter(source);
  const document = parseReviewMdxDocument(maskedSource);
  if (document.parseError) {
    const issues: StoredReviewDocumentMigrationIssue[] = [
      {
        code: "STANDARD_MDX_PARSE_ERROR",
        filePath,
        line: document.parseError.line,
        message: document.parseError.message,
      },
    ];
    issues.push(
      ...auditUnparseableStoredReviewDocument({
        filePath,
        source: maskedSource,
        reportedParseErrorLine: document.parseError.line,
      }),
    );
    return issues.sort((left, right) => left.line - right.line);
  }

  const issues: StoredReviewDocumentMigrationIssue[] = [];
  const importedAuthoringHelpers = new Set<string>();
  const reportedHelpers = new Set<string>();
  for (const program of document.esmPrograms) {
    for (const statement of program.body) {
      if (statement.type !== "ImportDeclaration") continue;
      if (statement.source.value === REVIEW_AUTHORING_MODULE_ID) {
        for (const specifier of statement.specifiers) {
          importedAuthoringHelpers.add(specifier.local.name);
        }
      }
      if (statement.source.value === LEGACY_REVIEW_AUTHORING_MODULE_ID) {
        issues.push({
          code: "LEGACY_AUTHORING_IMPORT",
          filePath,
          line: estreeLine(statement),
          message: legacyAuthoringImportMessage(),
        });
      }
    }
  }
  for (const program of document.esmPrograms) {
    for (const helper of LEGACY_IMPLICIT_AUTHORING_HELPERS) {
      if (
        importedAuthoringHelpers.has(helper) ||
        reportedHelpers.has(helper) ||
        findCallExpressions(program, helper).length === 0
      ) {
        continue;
      }
      const call = findCallExpressions(program, helper)[0];
      reportedHelpers.add(helper);
      issues.push({
        code: "IMPLICIT_AUTHORING_HELPER",
        filePath,
        line: estreeLine(call),
        message: implicitAuthoringHelperMessage(helper),
      });
    }
  }
  return issues;
}

function auditUnparseableStoredReviewDocument(input: {
  filePath: string;
  source: string;
  reportedParseErrorLine: number;
}): StoredReviewDocumentMigrationIssue[] {
  const issues: StoredReviewDocumentMigrationIssue[] = [];
  const reportedHelpers = new Set<string>();
  for (const { line, source } of mdxCodeLines(input.source)) {
    if (isLegacyAuthoringImport(source)) {
      issues.push({
        code: "LEGACY_AUTHORING_IMPORT",
        filePath: input.filePath,
        line,
        message: legacyAuthoringImportMessage({
          typeOnly: /^\s*import\s+type\b/.test(source),
        }),
      });
    }

    const helper = implicitAuthoringHelper(source);
    if (helper && !reportedHelpers.has(helper)) {
      reportedHelpers.add(helper);
      issues.push({
        code: "IMPLICIT_AUTHORING_HELPER",
        filePath: input.filePath,
        line,
        message: implicitAuthoringHelperMessage(helper),
      });
    }

    const syntax = typescriptOnlyMdxSyntax(source);
    if (syntax && line !== input.reportedParseErrorLine) {
      issues.push({
        code: "STANDARD_MDX_PARSE_ERROR",
        filePath: input.filePath,
        line,
        message: `${syntax} is TypeScript-only syntax and is not accepted by standard MDX.`,
      });
    }
  }
  return issues.sort((left, right) => left.line - right.line);
}

function mdxCodeLines(source: string): { line: number; source: string }[] {
  const result: { line: number; source: string }[] = [];
  let fence: "`" | "~" | undefined;
  for (const [index, lineSource] of source.split("\n").entries()) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(lineSource);
    if (fenceMatch) {
      const marker = fenceMatch[1].startsWith("`") ? "`" : "~";
      if (!fence) fence = marker;
      else if (fence === marker) fence = undefined;
      continue;
    }
    if (!fence) result.push({ line: index + 1, source: lineSource });
  }
  return result;
}

function isLegacyAuthoringImport(source: string): boolean {
  return (
    /^\s*import\b/.test(source) &&
    new RegExp(
      String.raw`\bfrom\s*["']${escapeRegex(LEGACY_REVIEW_AUTHORING_MODULE_ID)}["']`,
    ).test(source)
  );
}

function implicitAuthoringHelper(
  source: string,
): (typeof LEGACY_IMPLICIT_AUTHORING_HELPERS)[number] | undefined {
  const match =
    /^\s*export\s+const\s+[$\w]+(?:\s*:[^=]+)?\s*=\s*(defineActors|defineAnchors|defineSoftwareActors|defineSoftwareModel|defineSoftwareStores|defineStores)\s*\(/.exec(
      source,
    );
  const helper = match?.[1];
  return LEGACY_IMPLICIT_AUTHORING_HELPERS.find(
    (candidate) => candidate === helper,
  );
}

function typescriptOnlyMdxSyntax(source: string): string | undefined {
  if (/^\s*import\s+type\b/.test(source)) return "`import type`";
  if (/^\s*(?:export\s+)?interface\b/.test(source)) {
    return "an `interface` declaration";
  }
  if (/^\s*(?:export\s+)?type\s+[$\w]+\s*=/.test(source)) {
    return "a `type` declaration";
  }
  if (/^\s*export\s+const\s+[$\w]+\s*:[^=]+?=/.test(source)) {
    return "a type annotation";
  }
  if (/[}\]]\s+satisfies\b/.test(source)) return "`satisfies`";
  return undefined;
}

function legacyAuthoringImportMessage(input?: { typeOnly: boolean }): string {
  if (input?.typeOnly) {
    return `Delete this TypeScript-only import from the Review document; standard MDX cannot use imported types. The .mdx documents rely on runtime type validation now, so it is safe to delete wholesale rather than preserving.`;
  }
  return `Import Review runtime helpers from "${REVIEW_AUTHORING_MODULE_ID}", not "${LEGACY_REVIEW_AUTHORING_MODULE_ID}".`;
}

function implicitAuthoringHelperMessage(
  helper: (typeof LEGACY_IMPLICIT_AUTHORING_HELPERS)[number],
): string {
  return `${helper} is no longer injected into Review documents; import it explicitly from "${REVIEW_AUTHORING_MODULE_ID}".`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function estreeLine(node: EstreeNode | undefined): number {
  return node?.loc?.start.line ?? 1;
}

export interface StoredReviewMigrationOutcome {
  record: StoredReviewRecord;
  migrated: boolean;
  upgradedThreadDb: boolean;
  threadDbError?: string;
}

/** One review: record normalization, sealed artifact conversion, thread DB
 * upgrade. Shared by the CLI sweep and the store loader. Repo-level cleanup
 * (legacy checkouts, `repos/`) stays in the sweep. */
export async function migrateStoredReview(input: {
  reviewDir: string;
  log?: (message: string) => void;
}): Promise<StoredReviewMigrationOutcome> {
  const reviewPath = path.join(input.reviewDir, "review.mdx");
  const value = jsonObject(
    parseJsonText(
      await readFile(path.join(input.reviewDir, "review.json"), "utf8"),
    ),
  );
  const schemaVersion = value?.schemaVersion;
  if (
    !value ||
    ![2, 3, 4, REVIEW_SCHEMA_VERSION].includes(Number(schemaVersion))
  ) {
    throw new Error("Unsupported Review schema; the record was preserved.");
  }
  let migrationValue = value;
  if (schemaVersion === 3 || schemaVersion === 2) {
    migrationValue = await migrateReviewSourceSession({
      onWarning: (message) => input.log?.(message),
      value,
    });
  }
  const migratedRecord = parseStoredReviewRecordForMigration(migrationValue);
  if (migratedRecord.uuid !== path.basename(input.reviewDir))
    throw new Error("review.json UUID does not match its directory");
  const migrated = await regeneratePresentedArtifacts({
    reviewDir: input.reviewDir,
    review: migratedRecord,
    original: value,
    allowAbsentMap: schemaVersion === 2,
    log: input.log,
  });
  const record = parseStoredReviewRecord(
    parseJsonText(
      await readFile(path.join(input.reviewDir, "review.json"), "utf8"),
    ),
  );
  const threadDbMigration: ReviewThreadDbMigrationOptions = {
    force: false,
    preserveLegacyQuestions: true,
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
  } catch (error) {
    threadDbError = errorMessage(error);
  }
  return { record, migrated, upgradedThreadDb, threadDbError };
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

async function migrateReviewSourceSession(input: {
  onWarning?: (message: string) => void;
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
    const frozen = await createReviewSourceAgentSession({
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

async function regeneratePresentedArtifacts(input: {
  reviewDir: string;
  review: ReturnType<typeof parseStoredReviewRecordForMigration>;
  original: JsonObject;
  allowAbsentMap: boolean;
  log?: (message: string) => void;
}): Promise<boolean> {
  const staging = await mkdtemp(
    path.join(tmpdir(), "review-artifact-migration-"),
  );
  const documentDir = path.join(staging, "document");
  const mapDir = path.join(staging, "map");
  try {
    let documentBundle: ReturnType<typeof bundleReviewDocument> | null = null;
    let mapBundle: ReviewSoftwareMapBundle | null = null;
    let mapRevision = input.review.presentedSoftwareMapRevision;
    const documentRevision = input.review.presentedDocumentRevision;
    if (documentRevision) {
      await materializeReviewRevision(
        input.reviewDir,
        documentRevision,
        documentDir,
      );
      if (!(await readReviewDocumentBundle(documentDir, "/"))) {
        const modernPath = path.join(
          documentDir,
          ".bundle/document/manifest.json",
        );
        let legacyRoot = path.join(documentDir, ".bundle/document");
        let manifest: JsonObject | undefined;
        try {
          manifest = jsonObject(
            parseJsonText(await readFile(modernPath, "utf8")),
          );
        } catch (error) {
          if (!isMissingFileError(error)) throw error;
          legacyRoot = path.join(documentDir, ".bundle");
          manifest = jsonObject(
            parseJsonText(
              await readFile(path.join(legacyRoot, "manifest.json"), "utf8"),
            ),
          );
        }
        if (manifest?.version !== 1)
          throw new Error(
            "The presented document manifest is invalid or unsupported.",
          );
        const bundleCode = await readFile(
          path.join(legacyRoot, "review-document.js"),
          "utf8",
        );
        const evaluated = await evaluateReviewDocumentBundleForPublish({
          bundleCode,
          reviewDir: documentDir,
          validateRanges: false,
        });
        for (const warning of evaluated.warnings) input.log?.(warning);
        if (!evaluated.document)
          throw new Error(
            evaluated.errors.join("; ") ||
              "Review document did not materialize.",
          );
        documentBundle = bundleReviewDocument(evaluated.document);
      }
    }
    if (mapRevision) {
      await materializeReviewRevision(input.reviewDir, mapRevision, mapDir);
      if (!(await readReviewSoftwareMapBundle(mapDir))) {
        mapBundle = await legacySoftwareMapBundle(mapDir);
        if (!mapBundle) {
          if (!input.allowAbsentMap)
            throw new Error("The presented software map is missing.");
          mapRevision = null;
        }
      }
    }
    // Source migration and schema normalization must not race a lifecycle or pin change.
    return await withReviewMutationLock(input.reviewDir, async () => {
      const recordPath = path.join(input.reviewDir, "review.json");
      const currentText = await readFile(recordPath, "utf8");
      if (
        JSON.stringify(parseJsonText(currentText)) !==
        JSON.stringify(input.original)
      ) {
        throw new Error(
          "Review changed while preparing migration; rerun review migrate apply.",
        );
      }
      if (!documentBundle && !mapBundle) {
        if (
          input.original.schemaVersion !== REVIEW_SCHEMA_VERSION ||
          mapRevision !== input.review.presentedSoftwareMapRevision
        ) {
          await writePrivateJsonAtomic(recordPath, {
            ...input.review,
            presentedSoftwareMapRevision: mapRevision,
          });
          input.log?.("Migrated Review " + input.review.uuid + " to schema 5.");
          return true;
        }
        return false;
      }
      const backupDir = path.join(staging, "backup");
      const candidateDir = path.join(staging, "candidate");
      await cp(input.reviewDir, candidateDir, {
        recursive: true,
        filter: (source) => {
          const relative = path.relative(input.reviewDir, source);
          return (
            relative !== ".build" &&
            !relative.startsWith(`.build${path.sep}`) &&
            !/^review\.db(?:-|$)/.test(relative)
          );
        },
      });
      const candidateRecordPath = path.join(candidateDir, "review.json");
      await mkdir(backupDir);
      // The private index and refs belong to the same transaction as the candidates.
      // Backup before touching any byte; preparation itself never edits the review.
      const names = ["review.json", ".bundle", ".git"];
      for (const name of names)
        await copyIfPresent(
          path.join(input.reviewDir, name),
          path.join(backupDir, name),
        );
      let completed = false;
      const newRevisions: string[] = [];
      try {
        if (documentBundle) {
          await rm(path.join(candidateDir, ".bundle/document"), {
            recursive: true,
            force: true,
          });
          await rm(path.join(candidateDir, ".bundle/review-document.js"), {
            force: true,
          });
          await rm(path.join(candidateDir, ".bundle/manifest.json"), {
            force: true,
          });
          await writeReviewDocumentBundle(candidateDir, documentBundle);
        }
        if (mapBundle) {
          await rm(path.join(candidateDir, ".bundle/software-map"), {
            recursive: true,
            force: true,
          });
          await writeReviewSoftwareMapBundle(candidateDir, mapBundle);
        }
        let next = {
          ...input.review,
          presentedSoftwareMapRevision: mapRevision,
        };
        await writePrivateJsonAtomic(candidateRecordPath, next);
        if (mapBundle) {
          mapRevision = await sealReviewCandidate(
            candidateDir,
            "Migrate current Review software map to JSON",
          );
          newRevisions.push(mapRevision);
          next = { ...next, presentedSoftwareMapRevision: mapRevision };
          await writePrivateJsonAtomic(candidateRecordPath, next);
        }
        if (documentBundle) {
          const revision = await sealReviewCandidate(
            candidateDir,
            "Migrate current Review document to JSON",
          );
          newRevisions.push(revision);
          next = { ...next, presentedDocumentRevision: revision };
        }
        for (const revision of newRevisions) {
          await materializeReviewRevision(
            candidateDir,
            revision,
            path.join(input.reviewDir, ".build", revision),
          );
        }
        // Sealing used an isolated private repository. Neither presentation
        // pointer nor the stored schema changes until both artifacts exist.
        await rm(path.join(input.reviewDir, ".bundle"), {
          recursive: true,
          force: true,
        });
        await cp(
          path.join(candidateDir, ".bundle"),
          path.join(input.reviewDir, ".bundle"),
          { recursive: true, force: true },
        );
        await cp(
          path.join(candidateDir, ".git"),
          path.join(input.reviewDir, ".git"),
          { recursive: true, force: true },
        );
        await writePrivateJsonAtomic(recordPath, next);
        completed = true;
        input.log?.(
          "Migrated current presentation for Review " +
            input.review.uuid +
            " to JSON.",
        );
        return true;
      } finally {
        if (!completed) {
          for (const name of names) {
            await rm(path.join(input.reviewDir, name), {
              recursive: true,
              force: true,
            });
            await copyIfPresent(
              path.join(backupDir, name),
              path.join(input.reviewDir, name),
            );
          }
          for (const revision of newRevisions)
            await rm(path.join(input.reviewDir, ".build", revision), {
              recursive: true,
              force: true,
            });
        }
      }
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function copyIfPresent(
  source: string,
  destination: string,
): Promise<void> {
  try {
    await cp(source, destination, { recursive: true, force: true });
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

export async function legacySoftwareMapBundle(
  legacyBuildDir: string,
): Promise<ReviewSoftwareMapBundle | null> {
  const mapDir = path.join(legacyBuildDir, ".bundle", "software-map");
  let manifestValue: JsonObject | undefined;
  try {
    manifestValue = jsonObject(
      parseJsonText(await readFile(path.join(mapDir, "manifest.json"), "utf8")),
    );
  } catch (error) {
    if (isMissingFileError(error)) {
      try {
        await readdir(mapDir);
      } catch (directoryError) {
        if (isMissingFileError(directoryError)) return null;
        throw directoryError;
      }
      throw new Error("The presented software map has no manifest.");
    }
    throw error;
  }
  const headCommit = jsonString(manifestValue?.headCommit);
  const baseCommit = jsonString(manifestValue?.baseCommit);
  if (
    manifestValue?.version !== 1 ||
    !headCommit ||
    !baseCommit ||
    !/^[0-9a-f]{40}$/i.test(headCommit) ||
    !/^[0-9a-f]{40}$/i.test(baseCommit)
  ) {
    throw new Error(
      "The presented software-map manifest is invalid or unsupported.",
    );
  }
  const load = async (
    file: string,
  ): Promise<NormalizedSoftwareModel | null> => {
    const url = pathToFileURL(path.join(mapDir, file));
    url.searchParams.set("t", `${Date.now()}-${Math.random()}`);
    try {
      // SAFETY: an imported legacy map module has no static TypeScript shape;
      // isNormalizedSoftwareModel validates its default export before use.
      const module = (await import(url.href)) as { default?: unknown };
      return isNormalizedSoftwareModel(module.default) ? module.default : null;
    } catch {
      return null;
    }
  };
  const [head, base] = await Promise.all([
    load("head-map.js"),
    load("base-map.js"),
  ]);
  if (!head || !base)
    throw new Error(
      "The presented software map could not be converted; its sealed head or base bundle is invalid.",
    );
  return bundleReviewSoftwareMap({ head, base, headCommit, baseCommit });
}

async function listStoredReviewDocuments(
  reviewHome: string,
  options: {
    skipReviewUuids?: readonly string[];
    onlyUnpresented?: boolean;
  } = {},
): Promise<string[]> {
  const reviewPaths: string[] = [];
  for (const entry of await readDirectory(path.join(reviewHome, "reviews"))) {
    if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
    if (options.skipReviewUuids?.includes(entry.name)) continue;
    if (options.onlyUnpresented) {
      const record = parseStoredReviewRecordForMigration(
        parseJsonText(
          await readFile(
            path.join(reviewHome, "reviews", entry.name, "review.json"),
            "utf8",
          ),
        ),
      );
      if (record.presentedDocumentRevision) continue;
    }
    await collectStoredReviewDocuments(
      path.join(reviewHome, "reviews", entry.name),
      reviewPaths,
    );
  }
  return reviewPaths.sort();
}

async function collectStoredReviewDocuments(
  directory: string,
  reviewPaths: string[],
): Promise<void> {
  for (const entry of await readDirectory(directory)) {
    if (entry.isDirectory()) {
      if (
        ![".build", ".git", ".jj", "history", "node_modules"].includes(
          entry.name,
        )
      ) {
        await collectStoredReviewDocuments(
          path.join(directory, entry.name),
          reviewPaths,
        );
      }
      continue;
    }
    if (entry.isFile() && path.extname(entry.name) === ".mdx") {
      reviewPaths.push(path.join(directory, entry.name));
    }
  }
}

async function readDirectory(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}
