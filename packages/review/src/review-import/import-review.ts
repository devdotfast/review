import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseJsonText } from "@dev.fast/review-protocol";
import { loadReviewAgentTrace } from "@dev.fast/trace-core";

import { textIncludesQuote } from "../evidence";
import { isMissingFileError } from "../fs-utils";
import { type Block, ReviewInputError } from "../review-api/document";
import type { LocalReviewData } from "../review-api/local-data";
import type {
  ImportedVersionInput,
  ReviewStore,
  SnapshotOrigin,
} from "../review-api/store";
import { REVIEW_DOCUMENT_BUNDLE_DIR } from "../review-bundle";
import {
  type ReviewDocumentData,
  reviewDocumentDataSchema,
  upgradeReviewDocumentJson,
} from "../review-document-data";
import type { StoredReview } from "../review-home";
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

interface PreparedVersion {
  document: ReviewDocumentData;
  blocks: Block[];
  warnings: string[];
  createdAt: string;
}

/**
 * Import every sealed revision of a legacy review as a store version, oldest
 * first. Nothing under the review directory is written; the review's row in
 * the store is what marks it imported. All fallible work happens before the
 * first store write, so a failure leaves no partial review behind.
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

  if (store.has(reviewId)) return { kind: "current", reviewId };

  if (!record.presentedDocumentRevision)
    return { kind: "skipped", reviewId, reason: "never published" };

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

  let pins;

  try {
    pins = await data.resolvePins(
      repositoryId,
      record.baseCommit,
      record.sourceCommit ?? record.baseRef,
    );
  } catch (error) {
    if (error instanceof ReviewInputError)
      return { kind: "skipped", reviewId, reason: error.message };
    throw error;
  }

  const entries = await sealedRevisions(
    review,
    record.presentedDocumentRevision,
    input.log ?? reviewVcs.log,
  );

  if (!entries)
    return {
      kind: "skipped",
      reviewId,
      reason: "presented revision is not in the review log",
    };

  const warnings: string[] = [];
  const versions: PreparedVersion[] = [];
  let previousRaw: string | null = null;

  const traces = new TraceResolver({
    store,
    data,
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

    const isLast = index === entries.length - 1;

    const createdAt = entry.timestamp
      ? new Date(entry.timestamp * 1000).toISOString()
      : versions.length === 0
        ? record.createdAt
        : isLast
          ? (record.lastPublishedAt ?? now().toISOString())
          : record.createdAt;

    versions.push({ document, blocks, warnings: versionWarnings, createdAt });
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

      last.blocks.push({
        type: "section",
        title: "Software map",
        defaultCollapsed: true,
        children,
      });
    } else
      last.warnings.push(
        `map revision ${record.presentedSoftwareMapRevision} has no bundle`,
      );
  }

  if (last.warnings.length)
    last.blocks.unshift({
      type: "callout",
      tone: "warning",
      title: "Imported from the MDX review",
      children: [
        {
          type: "markdown",
          markdown: `${last.warnings.map((warning) => `- ${warning}`).join("\n")}\n`,
        },
      ],
    });

  const origin = originFrom(record);
  const title = record.title || last.document.title;
  let version = 0;

  for (const [index, prepared] of versions.entries()) {
    const versionInput: ImportedVersionInput = {
      reviewId,
      title,
      pins,
      document: prepared.blocks,
      createdAt: prepared.createdAt,
      origin,
    };

    if (index === 0) versionInput.attention = attentionFrom(record);
    const result = await store.importVersion(versionInput);

    version = result.version;

    if (index === versions.length - 1) warnings.push(...result.warnings);
  }

  return {
    kind: "imported",
    reviewId,
    title,
    version,
    warnings: [...new Set(warnings)],
  };
}

/** Log entries oldest first, up to and including the presented revision. */
async function sealedRevisions(
  review: StoredReview,
  presented: string,
  log: (dir: string) => Promise<ReviewVcsLogEntry[]>,
): Promise<ReviewVcsLogEntry[] | null> {
  const entries = await log(review.dir);

  if (entries.length === 0)
    return [{ oid: presented, message: "", timestamp: 0 }];

  const ordered = entries
    .map((entry, order) => ({ entry, order }))
    .sort(
      (left, right) =>
        left.entry.timestamp - right.entry.timestamp ||
        right.order - left.order,
    )
    .map(({ entry }) => entry);

  const end = ordered.findIndex((entry) => entry.oid === presented);

  return end === -1 ? null : ordered.slice(0, end + 1);
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

function originFrom(
  record: StoredReview["review"],
): SnapshotOrigin | undefined {
  const origin: SnapshotOrigin = {};

  if (record.sourceIdentity?.name) origin.branch = record.sourceIdentity.name;

  if (record.baseRef) origin.baseRef = record.baseRef;

  if (record.pullRequestNumber)
    origin.pullRequestNumber = record.pullRequestNumber;

  if (record.pullRequestUrl) origin.pullRequestUrl = record.pullRequestUrl;

  return Object.keys(origin).length ? origin : undefined;
}

function attentionFrom(record: StoredReview["review"]) {
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
      data: LocalReviewData;
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
