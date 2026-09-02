import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { REVIEW_SCHEMA_VERSION } from "@dev.fast/review-protocol";
import type { Expression, Program } from "estree";

import {
  authoringSessionKey,
  parseAuthoringSessionKey,
} from "./authoring-session";
import { errorMessage } from "./error-message";
import { writeReviewDocumentBundle } from "./review-bundle";
import { createLegacyCodeRecordMigrator } from "./review-code-target-migration";
import { maskReviewFrontmatter } from "./review-frontmatter";
import {
  ensureReviewPinnedCheckout,
  removeLegacyReviewCheckouts,
} from "./review-head-checkout";
import {
  materializeReviewRevision,
  parseStoredReviewRecord,
  parseStoredReviewRecordForMigration,
  sealReviewCandidate,
} from "./review-home";
import {
  findCallExpressions,
  objectLiteralProperties,
  parseReviewMdxDocument,
} from "./review-mdx-ast";
import { reviewTypescriptEstreeParser } from "./review-mdx-typescript-parser";
import { createReviewSourceAgentSession } from "./review-source-agent-session";
import { migrateReviewThreadDb } from "./review-thread-store-backend";
import { writePrivateJsonAtomic } from "./server/desktop-paths";
import { compileReviewDocumentBundle } from "./server/doc-bundler";
import {
  extractLegacyReviewSoftwareMapBundle,
  writeReviewSoftwareMapBundle,
} from "./software-map-bundle";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StoredReviewMigrationResult extends DroppedLegacyReviewState {
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

async function legacyJsonRecordCount(filePath: string): Promise<number> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  if (!source.trim()) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return 0;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return 0;
  }
  return Object.keys(parsed).length;
}

async function dropLegacyReviewState(
  reviewMdxPath: string,
  log: (message: string) => void = console.warn,
): Promise<DroppedLegacyReviewState> {
  const reviewDir = path.dirname(reviewMdxPath);
  const commentsPath = path.join(reviewDir, "comments.json");
  const questionsPath = path.join(reviewDir, "questions.json");
  const [droppedComments, droppedQuestions] = await Promise.all([
    legacyJsonRecordCount(commentsPath),
    legacyJsonRecordCount(questionsPath),
  ]);
  await Promise.all([
    rm(commentsPath, { force: true }),
    rm(questionsPath, { force: true }),
  ]);
  if (droppedComments + droppedQuestions > 0) {
    log(
      `Dropped ${droppedComments} legacy review comments and ${droppedQuestions} questions during Review schema migration.`,
    );
  }
  return { droppedComments, droppedQuestions };
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
}): Promise<StoredReviewDocumentAuditResult> {
  const reviewPaths = await listStoredReviewDocuments(input.reviewHome);
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
      const marker = fenceMatch[1][0] as "`" | "~";
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

function estreeLine(value: unknown): number {
  if (!value || typeof value !== "object") return 1;
  const line = (value as { loc?: { start?: { line?: unknown } } | null }).loc
    ?.start?.line;
  return typeof line === "number" ? line : 1;
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return total;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
    const reviewDir = path.join(reviewsRoot, entry.name);
    const reviewPath = path.join(reviewDir, "review.mdx");
    try {
      const value: unknown = JSON.parse(
        await readFile(path.join(reviewDir, "review.json"), "utf8"),
      );
      const schemaVersion =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as { schemaVersion?: unknown }).schemaVersion
          : undefined;
      const worktreePath =
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof (value as { worktreePath?: unknown }).worktreePath === "string"
          ? (value as { worktreePath: string }).worktreePath
          : null;
      if (worktreePath && !cleanedLegacyRoots.has(worktreePath)) {
        cleanedLegacyRoots.add(worktreePath);
        total.legacyCheckoutsRemoved += await removeLegacyReviewCheckouts({
          rootPath: worktreePath,
          onBlocker: input.onBlocker,
        });
      }
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        (schemaVersion !== REVIEW_SCHEMA_VERSION &&
          schemaVersion !== 3 &&
          schemaVersion !== 2)
      ) {
        await rm(reviewDir, { recursive: true, force: true });
        total.droppedReviews += 1;
        input.log?.(`Dropped old Review ${entry.name}.`);
        continue;
      }
      let migrationValue = value;
      if (schemaVersion === 3 || schemaVersion === 2) {
        const migratedSource = await migrateReviewSourceSession({
          onWarning: (message) => input.log?.(message),
          value: value as Record<string, unknown>,
        });
        migrationValue = migratedSource;
      }
      const migratedRecord =
        parseStoredReviewRecordForMigration(migrationValue);
      if (schemaVersion === 2) {
        const legacyRevision = (value as { presentedRevision?: unknown })
          .presentedRevision;
        try {
          if (typeof legacyRevision === "string") {
            await migrateLegacyPresentedArtifacts({
              reviewDir,
              review: migratedRecord,
              legacyRevision,
            });
          } else {
            await writePrivateJsonAtomic(
              path.join(reviewDir, "review.json"),
              migratedRecord,
            );
            await rm(path.join(reviewDir, ".bundle"), {
              recursive: true,
              force: true,
            });
          }
        } catch (error) {
          const message = `${reviewDir}: split artifact migration failed: ${errorMessage(error)}`;
          input.onBlocker?.(message);
          input.log?.(message);
          continue;
        }
      } else if (schemaVersion !== REVIEW_SCHEMA_VERSION) {
        await writePrivateJsonAtomic(
          path.join(reviewDir, "review.json"),
          migratedRecord,
        );
      } else {
        parseStoredReviewRecord(migrationValue);
      }
      const removedPeekKeys = await removedCodePeekKeys(reviewDir);
      if (removedPeekKeys.length > 0) {
        await rm(reviewDir, { recursive: true, force: true });
        total.droppedLegacyPeekReviews += 1;
        total.droppedReviews += 1;
        input.log?.(
          `Dropped Review ${entry.name} with removed peek fields: ${removedPeekKeys.join(", ")}.`,
        );
        continue;
      }
      try {
        const databaseMigration = await migrateReviewThreadDb(reviewPath, {
          force: input.force,
          ...(migratedRecord.sourceCommit
            ? {
                migrateLegacyCodeRecord: createLegacyCodeRecordMigrator({
                  rootPath: migratedRecord.worktreePath,
                  baseCommit: migratedRecord.baseCommit,
                  headCommit: migratedRecord.sourceCommit,
                }),
              }
            : {}),
          onDropLegacyCodeRecord: ({ threadId, kind, error }) => {
            total.droppedComments += 1;
            input.log?.(
              `Dropped unrecoverable ${kind} ${threadId} from Review ${entry.name}: ${errorMessage(error)}`,
            );
          },
        });
        if (databaseMigration === "upgraded") {
          total.upgradedThreadDatabases += 1;
          input.log?.(
            `Upgraded Review database ${entry.name} to the current schema.`,
          );
        }
      } catch (error) {
        input.onBlocker?.(
          `Review ${entry.name} database migration failed: ${errorMessage(error)}`,
        );
      }
      const result = await dropLegacyReviewState(reviewPath, input.log);
      total.droppedComments += result.droppedComments;
      total.droppedQuestions += result.droppedQuestions;
      total.documents += 1;
    } catch (error) {
      await rm(reviewDir, { recursive: true, force: true });
      total.droppedReviews += 1;
      input.log?.(
        `Dropped malformed Review ${entry.name}: ${errorMessage(error)}`,
      );
    }
  }
  return total;
}

async function migrateReviewSourceSession(input: {
  onWarning?: (message: string) => void;
  value: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const source = parseAuthoringSessionKey(
    typeof input.value.agentSession === "string"
      ? input.value.agentSession
      : undefined,
  );
  const uuid = typeof input.value.uuid === "string" ? input.value.uuid : null;
  const worktreePath =
    typeof input.value.worktreePath === "string"
      ? input.value.worktreePath
      : null;
  const sourceCommit =
    typeof input.value.sourceCommit === "string"
      ? input.value.sourceCommit
      : null;
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
    const priorAgentSessions =
      record.agentSessions &&
      typeof record.agentSessions === "object" &&
      !Array.isArray(record.agentSessions)
        ? record.agentSessions
        : {};
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

async function migrateLegacyPresentedArtifacts(input: {
  reviewDir: string;
  review: ReturnType<typeof parseStoredReviewRecordForMigration>;
  legacyRevision: string;
}): Promise<void> {
  const nonce = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const legacyBuildDir = path.join(
    input.reviewDir,
    ".build",
    `migration-source-${nonce}`,
  );
  const backupDir = path.join(
    input.reviewDir,
    ".build",
    `migration-backup-${nonce}`,
  );
  await materializeReviewRevision(
    input.reviewDir,
    input.legacyRevision,
    legacyBuildDir,
  );
  await writePrivateJsonAtomic(
    path.join(legacyBuildDir, "review.json"),
    input.review,
  );
  const compiled = await compileReviewDocumentBundle({
    reviewPath: path.join(legacyBuildDir, "review.mdx"),
    reviewDocumentsDir: path.join(legacyBuildDir, ".review-documents"),
    reviewRootPath: legacyBuildDir,
    routePath: "/",
  });
  if (!compiled.bundle) {
    throw new Error(
      compiled.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
    );
  }
  const legacyBundleCode = await readFile(
    path.join(legacyBuildDir, ".bundle", "review-document.js"),
    "utf8",
  ).catch(() => null);
  const mapBundle =
    input.review.sourceCommit && legacyBundleCode
      ? await extractLegacyReviewSoftwareMapBundle({
          bundleCode: legacyBundleCode,
          evaluationDir: path.join(legacyBuildDir, `.map-extract-${nonce}`),
          headCommit: input.review.sourceCommit,
          baseCommit: input.review.baseCommit,
        }).catch(() => null)
      : null;

  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  for (const name of ["review.mdx", "data.ts", "review.json", ".bundle"]) {
    await cp(path.join(input.reviewDir, name), path.join(backupDir, name), {
      recursive: true,
      force: true,
    }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  let completed = false;
  try {
    await Promise.all([
      cp(
        path.join(legacyBuildDir, "review.mdx"),
        path.join(input.reviewDir, "review.mdx"),
      ),
      cp(
        path.join(legacyBuildDir, "data.ts"),
        path.join(input.reviewDir, "data.ts"),
      ),
      writePrivateJsonAtomic(path.join(input.reviewDir, "review.json"), {
        ...input.review,
        presentedDocumentRevision: null,
        presentedSoftwareMapRevision: null,
      }),
      rm(path.join(input.reviewDir, ".bundle"), {
        recursive: true,
        force: true,
      }),
    ]);
    await writeReviewDocumentBundle(input.reviewDir, compiled.bundle);
    if (mapBundle) {
      await writeReviewSoftwareMapBundle(input.reviewDir, mapBundle);
    }
    const revision = await sealReviewCandidate(
      input.reviewDir,
      "Migrate Review publication artifacts",
    );
    await materializeReviewRevision(
      input.reviewDir,
      revision,
      path.join(input.reviewDir, ".build", revision),
    );
    await restoreMigrationAuthoringFiles(input.reviewDir, backupDir);
    await writePrivateJsonAtomic(path.join(input.reviewDir, "review.json"), {
      ...input.review,
      presentedDocumentRevision: revision,
      presentedSoftwareMapRevision: mapBundle ? revision : null,
    });
    completed = true;
  } finally {
    if (!completed) {
      await restoreMigrationAuthoringFiles(input.reviewDir, backupDir);
      await rm(path.join(input.reviewDir, ".bundle"), {
        recursive: true,
        force: true,
      });
      await cp(
        path.join(backupDir, ".bundle"),
        path.join(input.reviewDir, ".bundle"),
        { recursive: true, force: true },
      ).catch(() => undefined);
    }
    await Promise.all([
      rm(legacyBuildDir, { recursive: true, force: true }),
      rm(backupDir, { recursive: true, force: true }),
    ]);
  }
}

async function restoreMigrationAuthoringFiles(
  reviewDir: string,
  backupDir: string,
): Promise<void> {
  await Promise.all(
    ["review.mdx", "data.ts"].map((name) =>
      cp(path.join(backupDir, name), path.join(reviewDir, name), {
        force: true,
      }),
    ),
  );
  const record = await readFile(path.join(backupDir, "review.json"), "utf8");
  await writeFile(path.join(reviewDir, "review.json"), record, "utf8");
}

const REMOVED_CODE_PEEK_KEYS = new Set(["declarationId", "symbol"]);

async function removedCodePeekKeys(reviewDir: string): Promise<string[]> {
  let source: string;
  try {
    source = await readFile(path.join(reviewDir, "data.ts"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  let program: Program;
  try {
    program = reviewTypescriptEstreeParser.parse(source);
  } catch {
    return [];
  }

  const removed = new Set<string>();
  for (const call of findCallExpressions(program, "defineAnchors")) {
    const anchorMap = call.arguments[0];
    if (!anchorMap || anchorMap.type === "SpreadElement") continue;
    for (const anchor of objectLiteralProperties(anchorMap as Expression)) {
      const peek = objectLiteralProperties(anchor.value).find(
        (property) => property.name === "peek",
      );
      for (const property of objectLiteralProperties(peek?.value)) {
        if (REMOVED_CODE_PEEK_KEYS.has(property.name)) {
          removed.add(property.name);
        }
      }
    }
  }
  return [...removed].sort();
}

async function listStoredReviewDocuments(
  reviewHome: string,
): Promise<string[]> {
  const reviewPaths: string[] = [];
  for (const entry of await readDirectory(path.join(reviewHome, "reviews"))) {
    if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
