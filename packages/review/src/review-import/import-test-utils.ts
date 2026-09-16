import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  type JsonValue,
  jsonObject,
  parseJsonText,
} from "@dev.fast/review-protocol";
import { onTestFinished } from "vitest";

import { LEGACY_REVIEW_FIXTURES_ROOT } from "../fixtures/legacy-reviews/legacy-review-fixture";
import { openLocalReviewStore } from "../review-api/local-data";
import type { ProseTag, ReviewNode } from "../review-document-data";
import { type StoredReview, parseStoredReviewRecord } from "../review-home";
import type { ReviewVcsLogEntry } from "../review-vcs";
import {
  type ImportLegacyReviewInput,
  importLegacyReview,
} from "./import-review";

const exec = promisify(execFile);

export const el = (
  tag: ProseTag,
  children: ReviewNode[] = [],
  props: Record<string, string | number | boolean> = {},
): ReviewNode => ({ type: "element", tag, props, children });

export const text = (value: string): ReviewNode => ({ type: "text", value });

/** The footnote section a Markdown pipeline emits for a definition that quotes
 * an agent trace, the shape a legacy review takes when an aside cites a
 * session. `[^<label>]` references it. */
export const footnoteTraceQuoteSection = (label: string): ReviewNode =>
  el(
    "section",
    [
      el("ol", [
        el(
          "li",
          [
            el("p", [
              text("The agent "),
              {
                type: "component",
                name: "TraceQuote",
                props: { sessionId: "s1", event: 2 },
                children: [text("agent said so")],
              },
              text("."),
            ]),
          ],
          { id: `user-content-fn-${label}` },
        ),
      ]),
    ],
    { "data-footnotes": "true" },
  );

export async function scratchGitRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "import-repo-"));
  const git = (...args: string[]) => exec("git", ["-C", root, ...args]);
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "t@example.invalid");
  await git("config", "user.name", "t");
  await writeFile(
    path.join(root, "order.ts"),
    'export const status = "draft";\n',
  );
  await git("add", ".");
  await git("commit", "-qm", "base");
  const base = (await git("rev-parse", "HEAD")).stdout.trim();
  await writeFile(
    path.join(root, "order.ts"),
    'export const status = "queued";\n',
  );
  await git("commit", "-qam", "head");
  const head = (await git("rev-parse", "HEAD")).stdout.trim();

  return { root, base, head };
}

/** A schema-5 review directory whose sealed "revisions" live under
 * `.revisions/<oid>` and are served by `materializeFromRevisionDirs`. */
export async function syntheticLegacyReview(
  name: string,
  repo: { root: string; base: string; head: string },
  options: {
    revisions?: number;
    /** Seal the same document in every revision, like a map-only publish. */
    identical?: boolean;
    /** Files published beside the document, by path within the revision. */
    assets?: Record<string, Buffer>;
    overrides?: Record<string, JsonValue>;
  } = {},
) {
  const home = await mkdtemp(path.join(os.tmpdir(), "import-home-"));

  const golden = jsonObject(
    parseJsonText(
      await readFile(
        path.join(LEGACY_REVIEW_FIXTURES_ROOT, `${name}.expected-record.json`),
        "utf8",
      ),
    ),
  );

  if (!golden) throw new Error(`${name} has no record golden`);
  const dir = path.join(home, "reviews", String(golden.uuid));
  const count = options.revisions ?? 1;

  const oids = Array.from({ length: count }, (_, index) =>
    String(index + 1)
      .repeat(40)
      .slice(0, 40),
  );

  const document = await readFile(
    path.join(LEGACY_REVIEW_FIXTURES_ROOT, `${name}.expected-document.json`),
    "utf8",
  );

  const record = parseStoredReviewRecord({
    ...golden,
    worktreePath: repo.root,
    baseCommit: repo.base,
    sourceCommit: repo.head,
    presentedDocumentRevision: oids.at(-1) ?? null,
    presentedSoftwareMapRevision: null,
    ...options.overrides,
  });

  for (const [index, oid] of oids.entries()) {
    const revisionDir = path.join(dir, ".revisions", oid, ".bundle/document");
    await mkdir(revisionDir, { recursive: true });
    // Every revision but the last was sealed while head was still the base
    // commit, so imported versions carry the pins of their time.
    await writeFile(
      path.join(dir, ".revisions", oid, "review.json"),
      JSON.stringify({
        ...record,
        sourceCommit: index === oids.length - 1 ? repo.head : repo.base,
        presentedDocumentRevision: oid,
      }),
    );
    await writeFile(
      path.join(revisionDir, "manifest.json"),
      JSON.stringify({ version: 2, routePath: "/", sourcePath: "review.mdx" }),
    );
    // Each revision differs so none is deduplicated.
    await writeFile(
      path.join(revisionDir, "review-document.json"),
      options.identical
        ? document
        : document.replace(/"title": "([^"]*)"/, `"title": "$1 v${index}"`),
    );

    for (const [asset, bytes] of Object.entries(options.assets ?? {})) {
      const file = path.join(dir, ".revisions", oid, asset);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
    }
  }

  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "review.json"), JSON.stringify(record));
  const stored: StoredReview = { dir, review: record };

  return { home, dir, record, stored, oids };
}

/** A scratch repository, a synthetic legacy review sealed from `fixture` and an
 * open store, closed when the test ends. `importReview` runs the importer over
 * them, so a test can edit a sealed document first. */
export async function runImport(
  fixture: string,
  options: Parameters<typeof syntheticLegacyReview>[2] & {
    loadTrace?: ImportLegacyReviewInput["loadTrace"];
  } = {},
) {
  const repo = await scratchGitRepo();
  const review = await syntheticLegacyReview(fixture, repo, options);

  const { store, data } = openLocalReviewStore(
    path.join(review.home, "review-api.db"),
  );

  onTestFinished(() => store.close());

  return {
    ...review,
    repo,
    store,
    data,
    documentPath: (oid: string) =>
      path.join(
        review.dir,
        ".revisions",
        oid,
        ".bundle/document/review-document.json",
      ),
    importReview: () =>
      importLegacyReview({
        review: review.stored,
        store,
        data,
        materialize: materializeFromRevisionDirs,
        log: logFromRevisionDirs(review.oids),
        loadTrace: options.loadTrace ?? (async () => null),
      }),
  };
}

/** Serves every revision from the review's own `.revisions` directory. */
export const materializeFromRevisionDirs = async (
  review: { dir: string },
  revision: string,
) => path.join(review.dir, ".revisions", revision);

/** A log in newest-first order, like the real one, with increasing timestamps. */
export const logFromRevisionDirs =
  (oids: string[]) => async (): Promise<ReviewVcsLogEntry[]> =>
    oids
      .map((oid, index) => ({
        oid,
        message: `rev ${index}`,
        timestamp: 1_700_000_000 + index * 60,
      }))
      .reverse();
