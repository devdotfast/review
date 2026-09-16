import { createHash, randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
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
import { decodeImage } from "../review-api/image-decode";
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
import { evaluateSealedReviewDocument } from "../review-sealed-document";
import { type ReviewVcsLogEntry, reviewVcs } from "../review-vcs";
import { readReviewSoftwareMapBundle } from "../software-map-bundle";
import { legacySoftwareMapBundle } from "../stored-review-migration";
import {
  type ImageRequest,
  type TraceRequest,
  legacyDocumentToBlocks,
  repairImportedSectionHeadings,
} from "./legacy-blocks";
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
  /** Surviving checkouts of the same repository, used only after pin verification. */
  repositoryPaths?: string[];
  /** Recover sealed history skipped by earlier importers without replacing edits. */
  completeHistory?: boolean;
  archiveMap?: (map: {
    reviewId: string;
    documentRevision: string;
    mapRevision: string;
    blocks: Block[];
  }) => void;
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

  const progress = store.legacyImport(reviewId);
  const importedRevision = progress?.revision ?? null;

  // The import record outlives the review: a deleted review stays deleted.
  if (progress && !store.has(reviewId)) return { kind: "current", reviewId };

  if (
    !input.completeHistory &&
    importedRevision === record.presentedDocumentRevision
  )
    return { kind: "current", reviewId };

  const imported = store.has(reviewId);

  let resolved:
    | { repositoryId: string; pins: Pins; worktreePath: string }
    | undefined;

  for (const worktreePath of new Set([
    record.worktreePath,
    ...(input.repositoryPaths ?? []),
  ])) {
    try {
      const repositoryId = (await data.register(worktreePath)).id;

      const pins = await data.resolvePins(
        repositoryId,
        record.baseCommit,
        record.sourceCommit ?? record.baseRef,
      );

      resolved = { repositoryId, pins, worktreePath };
      break;
    } catch (error) {
      if (!(error instanceof ReviewInputError)) throw error;
    }
  }

  if (!resolved)
    return {
      kind: "skipped",
      reviewId,
      reason: `repository unavailable at ${record.worktreePath}`,
    };
  const { repositoryId, worktreePath } = resolved;

  const entries = await pendingRevisions(
    review,
    record.presentedDocumentRevision,
    input.completeHistory ? null : importedRevision,
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

  const known = new Set(
    input.completeHistory && imported
      ? store
          .history(reviewId)
          .map(({ version }) => store.read(reviewId, version).origin?.revision)
      : [],
  );

  const preserved =
    input.completeHistory && imported ? store.read(reviewId) : undefined;

  let repaired = false;
  const warnings: string[] = [];
  const versions: ImportedVersionInput[] = [];
  let lastWarnings: string[] = [];
  let previousRaw: string | null = null;

  const origin = originFrom(record);

  const traces = new TraceResolver({
    store,
    repositoryId,
    worktreePath,
    loadTrace: input.loadTrace ?? loadReviewAgentTrace,
  });

  const images = new ImageResolver({ store, repositoryId });

  for (const [index, entry] of entries.entries()) {
    const dir = await input.materialize(review, entry.oid);
    const raw = await readSealedDocument(dir);

    if (raw === null) {
      if (entry.oid === record.presentedDocumentRevision)
        throw new Error(
          `Published revision ${entry.oid} has no sealed document.`,
        );
      warnings.push(`revision ${entry.oid} has no sealed JSON document`);
      continue;
    }

    const sealedRecord = parseAnyStoredReviewRecord(
      parseJsonText(await readFile(path.join(dir, "review.json"), "utf8")),
    );

    const mapRevision =
      index === entries.length - 1
        ? record.presentedSoftwareMapRevision
        : sealedRecord.presentedSoftwareMapRevision;

    const signature = JSON.stringify([
      raw,
      sealedRecord.baseCommit,
      sealedRecord.sourceCommit,
      mapRevision,
    ]);

    if (
      mapRevision &&
      input.archiveMap &&
      entry.oid !== record.presentedDocumentRevision
    ) {
      const mapWarnings: string[] = [];

      const map = await importMapSection(
        review,
        mapRevision,
        input.materialize,
        store,
        repositoryId,
        mapWarnings,
      );

      if (!map) throw new Error(mapWarnings.join("; "));
      input.archiveMap({
        reviewId,
        documentRevision: entry.oid,
        mapRevision,
        blocks: [map],
      });
    }

    if (preserved?.origin?.revision === entry.oid) {
      const sealed = reviewDocumentDataSchema.parse(
        upgradeReviewDocumentJson(parseJsonText(raw)),
      );

      const document = repairImportedSectionHeadings(
        preserved.document,
        sealed,
      );

      if (document) {
        preserved.document = document;
        repaired = true;
      }
    }

    if (signature === previousRaw) continue;
    previousRaw = signature;

    if (known.has(entry.oid)) continue;

    const document = reviewDocumentDataSchema.parse(
      upgradeReviewDocumentJson(parseJsonText(raw)),
    );

    const conversion = legacyDocumentToBlocks(document);
    const versionWarnings = [...conversion.warnings];

    const blocks = await images.resolve(
      await traces.resolve(
        conversion.blocks,
        conversion.traces,
        versionWarnings,
      ),
      conversion.images,
      dir,
      versionWarnings,
    );

    if (input.completeHistory && versionWarnings.length)
      throw new Error(`revision ${entry.oid}: ${versionWarnings.join("; ")}`);

    // Each sealed revision carries the record it was sealed with, so its
    // peeks resolve against the pins of that time, not today's.
    const pins = await revisionPins(dir, entry.oid, data, repositoryId);

    if (mapRevision && entry.oid === record.presentedDocumentRevision) {
      const map = await importMapSection(
        review,
        mapRevision,
        input.materialize,
        store,
        repositoryId,
        versionWarnings,
      );

      if (!map && input.completeHistory)
        throw new Error(versionWarnings.join("; "));

      if (map) blocks.push(map);
    }

    const isLast = index === entries.length - 1;

    const createdAt = entry.timestamp
      ? new Date(entry.timestamp * 1000).toISOString()
      : isLast
        ? (record.lastPublishedAt ?? now().toISOString())
        : record.createdAt;

    const versionOrigin = isLast ? origin : originFrom(sealedRecord);

    versions.push({
      reviewId,
      title: (isLast ? record.title : sealedRecord.title) || document.title,
      pins,
      document: blocks,
      createdAt,
      origin: {
        ...versionOrigin,
        revision: entry.oid,
      },
    });
    lastWarnings = versionWarnings;
    warnings.push(...versionWarnings);
  }

  const last = versions.at(-1);

  if (!last && imported) {
    if (repaired) {
      const result = await store.importVersions([], {
        preserveCurrent: preserved,
        revision: record.presentedDocumentRevision,
      });

      return {
        kind: "imported",
        reviewId,
        title: store.read(reviewId).title,
        version: result.version,
        warnings: result.warnings,
      };
    }

    return { kind: "current", reviewId };
  }

  if (!last)
    return {
      kind: "skipped",
      reviewId,
      reason: "no sealed JSON document in any revision",
    };

  // The cursor is the presented revision this import covered, even when that
  // revision's document was identical to an earlier one and wrote no version.
  // The import cursor is separate from each historical snapshot's provenance.

  // Keep migration diagnostics in the import result/log, not authored content.
  lastWarnings.push(...(await unresolvedSources(last, data)));

  const importWarnings = [...new Set(lastWarnings)];

  if (!imported) versions[0]!.attention = attentionFrom(record);

  const result = await store.importVersions(versions, {
    preserveCurrent: preserved,
    revision: record.presentedDocumentRevision,
  });

  return {
    kind: "imported",
    reviewId,
    title: last.title,
    version: result.version,
    warnings: [
      ...new Set([...warnings, ...importWarnings, ...result.warnings]),
    ],
  };
}

async function importMapSection(
  review: StoredReview,
  revision: string,
  materialize: ImportLegacyReviewInput["materialize"],
  store: ReviewStore,
  repositoryId: string,
  warnings: string[],
): Promise<Block | null> {
  try {
    const dir = await materialize(review, revision);

    const bundle =
      (await readReviewSoftwareMapBundle(dir)) ??
      (await legacySoftwareMapBundle(dir));

    if (!bundle) {
      warnings.push(`map revision ${revision} has no bundle`);

      return null;
    }

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

    return {
      type: "section",
      title: "Software map",
      defaultCollapsed: true,
      children,
    };
  } catch (error) {
    warnings.push(
      `map revision ${revision} could not be imported: ${errorMessage(error)}`,
    );

    return null;
  }
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
    if (!isMissingFileError(error)) throw error;

    // Import sealed presentations, never rebuild mutable authoring inputs.
    for (const bundleDir of [REVIEW_DOCUMENT_BUNDLE_DIR, ".bundle"]) {
      try {
        await access(path.join(dir, bundleDir, "review-document.js"));
      } catch (missing) {
        if (isMissingFileError(missing)) continue;
        throw missing;
      }

      const evaluated = await evaluateSealedReviewDocument(dir);

      return JSON.stringify(evaluated.document);
    }

    return null;
  }
}

async function revisionPins(
  dir: string,
  oid: string,
  data: LocalReviewData,
  repositoryId: string,
): Promise<Pins> {
  try {
    const record = parseAnyStoredReviewRecord(
      parseJsonText(await readFile(path.join(dir, "review.json"), "utf8")),
    );

    return await data.resolvePins(
      repositoryId,
      record.baseCommit,
      record.sourceCommit ?? record.baseRef,
    );
  } catch (error) {
    throw new Error(
      `revision ${oid}: cannot recover exact source pins (${errorMessage(error)})`,
    );
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
        markdown: `${request.quote
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}\n`,
      };

      const trace = await this.load(request);

      if (!trace) {
        warnings.push(`trace ${request.sessionId} unavailable; quoted as text`);
        replacements.set(request.placeholder, quoted);
        continue;
      }

      const wanted = String(request.eventIndex ?? 0);

      const event = trace.resource.events.find(
        (candidate) => candidate.id === wanted,
      );

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

/** Stores each published image once per review and rewrites placeholder
 * blocks. Resources are keyed by what the file decoded to, so a screenshot
 * republished unchanged across revisions is one resource, while one edited
 * between revisions becomes a second and each version keeps what it showed. */
class ImageResolver {
  private readonly stored = new Map<string, string>();

  constructor(
    private readonly input: { store: ReviewStore; repositoryId: string },
  ) {}

  async resolve(
    blocks: Block[],
    requests: ImageRequest[],
    dir: string,
    warnings: string[],
  ): Promise<Block[]> {
    if (requests.length === 0) return blocks;
    const replacements = new Map<string, Block>();

    for (const request of requests) {
      try {
        replacements.set(request.placeholder, {
          type: "image",
          assetId: await this.resource(request.src, dir),
          alt: request.alt,
        });
      } catch (error) {
        warnings.push(
          `image "${request.src}" could not be imported: ${errorMessage(error)}`,
        );
        replacements.set(request.placeholder, {
          type: "markdown",
          markdown: `*${request.alt}*\n`,
        });
      }
    }

    return replace(blocks, replacements);
  }

  private async resource(src: string, dir: string): Promise<string> {
    const root = path.resolve(dir);
    // A legacy review addressed its published files from its own root, so a
    // leading slash is the review directory, not the filesystem.
    const file = path.resolve(root, src.replace(/^\/+/, ""));

    // The sealed revision is the whole of what the review published.
    if (file !== root && !file.startsWith(root + path.sep))
      throw new Error("outside the review");

    const png = await decodeImage(await readFile(file));
    const digest = createHash("sha256").update(png).digest("hex");
    const kept = this.stored.get(digest);

    if (kept) return kept;

    const id = randomUUID();
    this.input.store.putResource(
      id,
      this.input.repositoryId,
      "image",
      "image/png",
      png,
    );
    this.stored.set(digest, id);

    return id;
  }
}

function replace(blocks: Block[], replacements: Map<string, Block>): Block[] {
  return blocks.map((block) => {
    if (block.type === "markdown") {
      return {
        ...block,
        markdown: block.markdown.replace(
          /\[((?:\\[\s\S]|[^\]\\])*)\]\(review-trace:(trace-placeholder-\d+)#[^)]+\)/g,
          (link, label: string, id: string) => {
            const quote = replacements.get(id);

            return quote?.type === "trace_quote"
              ? `[${label}](review-trace:${quote.traceId}#${encodeURIComponent(quote.eventId)})`
              : `“${label}”`;
          },
        ),
      };
    }

    if (block.type === "trace_quote") {
      return replacements.get(block.traceId) ?? block;
    }

    if (block.type === "image") {
      return replacements.get(block.assetId) ?? block;
    }

    if (block.type === "section" || block.type === "callout")
      return { ...block, children: replace(block.children, replacements) };

    return block;
  });
}
