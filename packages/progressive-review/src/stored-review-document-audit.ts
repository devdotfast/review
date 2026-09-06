import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseJsonText } from "@dev.fast/review-protocol";
import type { Node as EstreeNode } from "estree";

import { readDirectory } from "./fs-utils";
import { maskReviewFrontmatter } from "./review-frontmatter";
import { parseAnyStoredReviewRecord } from "./review-home";
import { findCallExpressions, parseReviewMdxDocument } from "./review-mdx-ast";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      const record = parseAnyStoredReviewRecord(
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
