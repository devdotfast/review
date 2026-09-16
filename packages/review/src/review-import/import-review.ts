import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseJsonText } from "@dev.fast/review-protocol";
import { errorMessage, loadReviewAgentTrace } from "@dev.fast/trace-core";

import { textIncludesQuote } from "../evidence";
import { isMissingFileError } from "../fs-utils";
import {
  type Block,
  type Pins,
  ReviewInputError,
  sourceReferences,
} from "../review-api/document";
import type { LocalReviewData } from "../review-api/local-data";
import type {
  ImportedVersionInput,
  ReviewStore,
  SnapshotOrigin,
} from "../review-api/store";
import { REVIEW_DOCUMENT_BUNDLE_DIR } from "../review-bundle";
import {
  reviewDocumentDataSchema,
  upgradeReviewDocumentJson,
} from "../review-document-data";
import { type StoredReview, parseAnyStoredReviewRecord } from "../review-home";
import { type ReviewVcsLogEntry, reviewVcs } from "../review-vcs";
import { readReviewSoftwareMapBundle } from "../software-map-bundle";
import { type TraceRequest, legacyDocumentToBlocks } from "./legacy-blocks";
import {
  type TraceResource,
  mapResourcesFromBundle,
  traceResourceFromLoaded,
} from "./legacy-resources";

export type ImportOutcome =
  | {
      kind: "imported";
      reviewId: string;
      title: string;
      version: number;
      warnings: string[];
    }
  | { kind: "current"; reviewId: string }
  | { kind: "skipped"; reviewId: string; reason: string };

export interface ImportLegacyReviewInput {
  review: StoredReview;
  store: ReviewStore;
  data: LocalReviewData;
  /** A directory holding the review at `revision` (the server's cache). */
  materialize: (review: StoredReview, revision: string) => Promise<string>;
  log?: (dir: string) => Promise<ReviewVcsLogEntry[]>;
  loadTrace?: typeof loadReviewAgentTrace;
  now?: () => Date;
}

const SEALED_DOCUMENT_FILE = "review-document.json";

type StoredRecord = StoredReview["review"];

/**
 * Import the sealed revisions of a legacy review as store versions, oldest
 * first. The review's row in the store marks it imported; each version records
 * the legacy revision it came from, so a review whose presented revision moved
 * on (a publish that overlapped the sweep, or an interrupted import) gets only
 * the missing revisions appended. Every version is prepared and validated
 * before the store writes them in one transaction. Nothing under the review
 * directory is written.
 */
export async function importLegacyReview(
  input: ImportLegacyReviewInput,
): Promise<ImportOutcome> {
  const { review, store, data } = input;
  const record = review.review;
  const reviewId = record.uuid;
  const now = input.now ?? (() => new Date());

  if (record.visibility === "system")
    return { kind: "skipped", reviewId, reason: "system review" };

  if (!record.presentedDocumentRevision)
    return { kind: "skipped", reviewId, reason: "never published" };

  const imported = store.has(reviewId) ? store.read(reviewId) : null;
  const importedRevision = imported?.origin?.revision ?? null;

  // A review imported before revisions were recorded cannot be resumed.
  if (imported && importedRevision === null)
    return { kind: "current", reviewId };

  if (importedRevision === record.presentedDocumentRevision)
    return { kind: "current", reviewId };

  let repositoryId: string;

  try {
    repositoryId = (await data.register(record.worktreePath)).id;
  } catch (error) {
    if (error instanceof ReviewInputError)
      return {
        kind: "skipped",
        reviewId,
        reason: `repository unavailable at ${record.worktreePath}`,
      };
    throw error;
  }

  let currentPins: Pins;

  try {
    currentPins = await data.resolvePins(
      repositoryId,
      record.baseCommit,
      record.sourceCommit ?? record.baseRef,
    );
  } catch (error) {
    if (error instanceof ReviewInputError)
      return { kind: "skipped", reviewId, reason: error.message };
    throw error;
  }

  const entries = await pendingRevisions(
    review,
    record.presentedDocumentRevision,
    importedRevision,
    input.log ?? reviewVcs.log,
  );

  if (!entries)
    return {
      kind: "skipped",
      reviewId,
      reason: importedRevision
        ? `imported revision ${importedRevision} is not in the review log`
        : "presented revision is not in the review log",
    };

  const warnings: string[] = [];
  const versions: ImportedVersionInput[] = [];
  let lastWarnings: string[] = [];
  let previousRaw: string | null = null;
  const origin = originFrom(record);

  const traces = new TraceResolver({
    store,
    repositoryId,
    worktreePath: record.worktreePath,
    loadTrace: input.loadTrace ?? loadReviewAgentTrace,
  });

  for (const [index, entry] of entries.entries()) {
    const dir = await input.materialize(review, entry.oid);
    const raw = await readSealedDocument(dir);

    if (raw === null) {
      warnings.push(`revision ${entry.oid} has no sealed JSON document`);
      continue;
    }

    if (raw === previousRaw) continue;
    previousRaw = raw;

    const document = reviewDocumentDataSchema.parse(
      upgradeReviewDocumentJson(parseJsonText(raw)),
    );

    const conversion = legacyDocumentToBlocks(document);
    const versionWarnings = [...conversion.warnings];

    const blocks = await traces.resolve(
      conversion.blocks,
      conversion.traces,
      versionWarnings,
    );

    // Each sealed revision carries the record it was sealed with, so its
    // peeks resolve against the pins of that time, not today's.
    const pins = await revisionPins(
      dir,
      entry.oid,
      data,
      repositoryId,
      currentPins,
      versionWarnings,
    );

    const isLast = index === entries.length - 1;

    const createdAt = entry.timestamp
      ? new Date(entry.timestamp * 1000).toISOString()
      : isLast
        ? (record.lastPublishedAt ?? now().toISOString())
        : record.createdAt;

    versions.push({
      reviewId,
      title: record.title || document.title,
      pins,
      document: blocks,
      createdAt,
      origin: { ...origin, revision: entry.oid },
    });
    lastWarnings = versionWarnings;
    warnings.push(...versionWarnings);
  }

  const last = versions.at(-1);

  if (!last)
    return {
      kind: "skipped",
      reviewId,
      reason: "no sealed JSON document in any revision",
    };

  if (record.presentedSoftwareMapRevision) {
    const mapDir = await input.materialize(
      review,
      record.presentedSoftwareMapRevision,
    );

    const bundle = await readReviewSoftwareMapBundle(mapDir);

    if (bundle) {
      const children: Block[] = [];

      for (const payload of mapResourcesFromBundle(bundle)) {
        const mapVersionId = randomUUID();
        store.putResource(
          mapVersionId,
          repositoryId,
          "map",
          "application/json",
          Buffer.from(payload.json),
        );
        children.push({ type: "software_map", mapVersionId });
      }

      last.document.push({
        type: "section",
        title: "Software map",
        defaultCollapsed: true,
        children,
      });
    } else
      lastWarnings.push(
        `map revision ${record.presentedSoftwareMapRevision} has no bundle`,
      );
  }

  // Source ranges that no longer resolve are reported in the document, so the
  // check runs now, before the callout is built.
  lastWarnings.push(...(await unresolvedSources(last, data)));

  const calloutWarnings = [...new Set(lastWarnings)];

  if (calloutWarnings.length)
    last.document.unshift({
      type: "callout",
      tone: "warning",
      title: "Imported from the MDX review",
      children: [
        {
          type: "markdown",
          markdown: `${calloutWarnings.map((warning) => `- ${warning}`).join("\n")}\n`,
        },
      ],
    });

  if (!imported) versions[0]!.attention = attentionFrom(record);
  const result = await store.importVersions(versions);

  return {
    kind: "imported",
    reviewId,
    title: last.title,
    version: result.version,
    warnings: [
      ...new Set([...warnings, ...calloutWarnings, ...result.warnings]),
    ],
  };
}

/** Log entries oldest first, after the last imported revision and up to and
 * including the presented one. Null when either is missing from the log. */
async function pendingRevisions(
  review: StoredReview,
  presented: string,
  imported: string | null,
  log: (dir: string) => Promise<ReviewVcsLogEntry[]>,
): Promise<ReviewVcsLogEntry[] | null> {
  const entries = await log(review.dir);

  if (entries.length === 0)
    return imported ? null : [{ oid: presented, message: "", timestamp: 0 }];

  const ordered = entries
    .map((entry, order) => ({ entry, order }))
    .sort(
      (left, right) =>
        left.entry.timestamp - right.entry.timestamp ||
        right.order - left.order,
    )
    .map(({ entry }) => entry);

  const end = ordered.findIndex((entry) => entry.oid === presented);

  if (end === -1) return null;

  const start = imported
    ? ordered.findIndex((entry) => entry.oid === imported)
    : -1;

  if (imported && start === -1) return null;

  return ordered.slice(start + 1, end + 1);
}

async function readSealedDocument(dir: string): Promise<string | null> {
  try {
    return await readFile(
      path.join(dir, REVIEW_DOCUMENT_BUNDLE_DIR, SEALED_DOCUMENT_FILE),
      "utf8",
    );
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

async function revisionPins(
  dir: string,
  oid: string,
  data: LocalReviewData,
  repositoryId: string,
  fallback: Pins,
  warnings: string[],
): Promise<Pins> {
  let record: StoredRecord;

  try {
    record = parseAnyStoredReviewRecord(
      parseJsonText(await readFile(path.join(dir, "review.json"), "utf8")),
    );
  } catch (error) {
    warnings.push(
      `revision ${oid}: record unreadable (${errorMessage(error)}); using current pins`,
    );

    return fallback;
  }

  try {
    return await data.resolvePins(
      repositoryId,
      record.baseCommit,
      record.sourceCommit ?? record.baseRef,
    );
  } catch (error) {
    if (!(error instanceof ReviewInputError)) throw error;
    warnings.push(
      `revision ${oid}: pins unresolved (${error.message}); using current pins`,
    );

    return fallback;
  }
}

async function unresolvedSources(
  version: ImportedVersionInput,
  data: LocalReviewData,
): Promise<string[]> {
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const { source, peek } of sourceReferences(version.document, {
    tolerant: true,
  })) {
    const key = JSON.stringify(source);

    if (seen.has(key)) continue;
    seen.add(key);

    const warning = await data.validateSourceTolerant(version.pins, source, {
      peek: peek === true,
    });

    if (warning) warnings.push(warning);
  }

  return warnings;
}

function originFrom(record: StoredRecord): SnapshotOrigin {
  const origin: SnapshotOrigin = {};

  if (record.sourceIdentity?.name) origin.branch = record.sourceIdentity.name;

  if (record.baseRef) origin.baseRef = record.baseRef;

  if (record.pullRequestNumber)
    origin.pullRequestNumber = record.pullRequestNumber;

  if (record.pullRequestUrl) origin.pullRequestUrl = record.pullRequestUrl;

  return origin;
}

function attentionFrom(record: StoredRecord) {
  const terminal = record.status === "accepted" || record.status === "rejected";

  return {
    viewedAt: record.viewedAt ?? null,
    dismissedAt:
      record.dismissedAt ??
      (terminal ? (record.lastPublishedAt ?? record.createdAt) : null),
  };
}

/** Uploads each quoted trace once per review and rewrites placeholder quotes. */
class TraceResolver {
  private readonly loaded = new Map<
    string,
    Promise<{ id: string; resource: TraceResource } | null>
  >();

  constructor(
    private readonly input: {
      store: ReviewStore;
      repositoryId: string;
      worktreePath: string;
      loadTrace: typeof loadReviewAgentTrace;
    },
  ) {}

  async resolve(
    blocks: Block[],
    requests: TraceRequest[],
    warnings: string[],
  ): Promise<Block[]> {
    if (requests.length === 0) return blocks;
    const replacements = new Map<string, Block>();

    for (const request of requests) {
      const quoted: Block = {
        type: "markdown",
        markdown: `> ${request.quote}\n`,
      };

      const trace = await this.load(request);

      if (!trace) {
        warnings.push(`trace ${request.sessionId} unavailable; quoted as text`);
        replacements.set(request.placeholder, quoted);
        continue;
      }

      const events = trace.resource.events;

      const event =
        events[Math.min(request.eventIndex ?? 0, events.length - 1)];

      if (!event || !textIncludesQuote(event.text, request.quote)) {
        warnings.push(
          `quote not found in trace ${request.sessionId} event ${request.eventIndex ?? 0}; quoted as text`,
        );
        replacements.set(request.placeholder, quoted);
        continue;
      }

      replacements.set(request.placeholder, {
        type: "trace_quote",
        traceId: trace.id,
        eventId: event.id,
        text: request.quote,
      });
    }

    return replace(blocks, replacements);
  }

  private load(request: TraceRequest) {
    const key = `${request.sessionId}\0${request.trace ?? "main"}`;
    let pending = this.loaded.get(key);

    if (!pending) {
      pending = this.input
        .loadTrace({
          sessionId: request.sessionId,
          trace: request.trace,
          cwd: this.input.worktreePath,
        })
        .then((loaded) => {
          if (!loaded) return null;
          const resource = traceResourceFromLoaded(loaded);
          const id = randomUUID();
          this.input.store.putResource(
            id,
            this.input.repositoryId,
            "trace",
            "application/json",
            Buffer.from(
              JSON.stringify({ ...resource, provenance: "legacy_import" }),
            ),
          );

          return { id, resource };
        })
        .catch(() => null);
      this.loaded.set(key, pending);
    }

    return pending;
  }
}

function replace(blocks: Block[], replacements: Map<string, Block>): Block[] {
  return blocks.map((block) => {
    if (block.type === "trace_quote") {
      return replacements.get(block.traceId) ?? block;
    }

    if (block.type === "section" || block.type === "callout")
      return { ...block, children: replace(block.children, replacements) };

    return block;
  });
}
