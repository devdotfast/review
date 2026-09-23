import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  type JsonValue,
  jsonObject,
  parseJsonText,
} from "@dev.fast/whiteboard-protocol";
import { onTestFinished } from "vitest";

import { LEGACY_WHITEBOARD_FIXTURES_ROOT } from "../fixtures/legacy-reviews/legacy-review-fixture";
import { openLocalSessionStore } from "../session-api/local-data";
import { WHITEBOARD_SOFTWARE_MAP_BUNDLE_DIR } from "../software-map-bundle";
import type { ProseTag, WhiteboardNode } from "../whiteboard-document-data";
import {
  type StoredWhiteboard,
  parseStoredWhiteboardRecord,
} from "../whiteboard-home";
import type { WhiteboardVcsLogEntry } from "../whiteboard-vcs";
import {
  type ImportLegacyWhiteboardInput,
  importLegacyWhiteboard,
} from "./import-review";

const exec = promisify(execFile);

export const el = (
  tag: ProseTag,
  children: WhiteboardNode[] = [],
  props: Record<string, string | number | boolean> = {},
): WhiteboardNode => ({ type: "element", tag, props, children });

export const text = (value: string): WhiteboardNode => ({
  type: "text",
  value,
});

/** The footnote section a legacy review sealed for a definition, `[^<label>]`,
 * that quotes an agent trace. */
export const footnoteTraceQuoteSection = (label: string): WhiteboardNode =>
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
export async function syntheticLegacyWhiteboard(
  name: string,
  repo: { root: string; base: string; head: string },
  options: {
    revisions?: number;
    /** Seal the same document in every revision, like a map-only publish. */
    identical?: boolean;
    /** Files published beside the document, by path within the revision. */
    assets?: Record<string, Buffer>;
    /** A presented software map, sealed as its own revision. */
    map?: { oid: string; headCommit?: string; baseCommit?: string };
    overrides?: Record<string, JsonValue>;
  } = {},
) {
  const home = await mkdtemp(path.join(os.tmpdir(), "import-home-"));

  const golden = jsonObject(
    parseJsonText(
      await readFile(
        path.join(
          LEGACY_WHITEBOARD_FIXTURES_ROOT,
          `${name}.expected-record.json`,
        ),
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
    path.join(
      LEGACY_WHITEBOARD_FIXTURES_ROOT,
      `${name}.expected-document.json`,
    ),
    "utf8",
  );

  const record = parseStoredWhiteboardRecord({
    ...golden,
    worktreePath: repo.root,
    baseCommit: repo.base,
    sourceCommit: repo.head,
    presentedDocumentRevision: oids.at(-1) ?? null,
    presentedSoftwareMapRevision: options.map?.oid ?? null,
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

  if (options.map)
    await sealLegacyMapRevision(dir, options.map.oid, {
      headCommit: options.map.headCommit ?? repo.head,
      baseCommit: options.map.baseCommit ?? repo.base,
    });
  const stored: StoredWhiteboard = { dir, review: record };

  return { home, dir, record, stored, oids };
}

/** A synthetic legacy review sealed from `fixture` in a scratch repository, and
 * an open store closed when the test ends; `importWhiteboard` imports the former
 * into the latter. */
export async function runImport(
  fixture: string,
  options: Parameters<typeof syntheticLegacyWhiteboard>[2] & {
    loadTrace?: ImportLegacyWhiteboardInput["loadTrace"];
  } = {},
) {
  const repo = await scratchGitRepo();
  const review = await syntheticLegacyWhiteboard(fixture, repo, options);

  const { store, data } = openLocalSessionStore(
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
    /** `stored` overrides the review record, for a revision published later. */
    importWhiteboard: (stored: StoredWhiteboard = review.stored) =>
      importLegacyWhiteboard({
        review: stored,
        store,
        data,
        materialize: materializeFromRevisionDirs,
        log: logFromRevisionDirs(review.oids),
        loadTrace: options.loadTrace ?? (async () => null),
      }),
  };
}

/** Seals a map bundle as a revision of its own, as `review map publish` did. */
export async function sealLegacyMapRevision(
  dir: string,
  oid: string,
  commits: { headCommit: string; baseCommit: string },
): Promise<void> {
  const bundleDir = path.join(
    dir,
    ".revisions",
    oid,
    WHITEBOARD_SOFTWARE_MAP_BUNDLE_DIR,
  );

  await mkdir(bundleDir, { recursive: true });

  const golden = jsonObject(
    parseJsonText(
      await readFile(
        path.join(
          LEGACY_WHITEBOARD_FIXTURES_ROOT,
          "schema4-opencode-agentserver.expected-map.json",
        ),
        "utf8",
      ),
    ),
  );

  if (!golden) throw new Error("the software map golden is unreadable");
  await Promise.all([
    writeFile(path.join(bundleDir, "head-map.json"), String(golden.headJson)),
    writeFile(path.join(bundleDir, "base-map.json"), String(golden.baseJson)),
    writeFile(
      path.join(bundleDir, "manifest.json"),
      JSON.stringify({ version: 2, ...commits }),
    ),
  ]);
}

/** Serves every revision from the review's own `.revisions` directory. */
export const materializeFromRevisionDirs = async (
  review: { dir: string },
  revision: string,
) => path.join(review.dir, ".revisions", revision);

/** A log in newest-first order, like the real one, with increasing timestamps. */
export const logFromRevisionDirs =
  (oids: string[]) => async (): Promise<WhiteboardVcsLogEntry[]> =>
    oids
      .map((oid, index) => ({
        oid,
        message: `rev ${index}`,
        timestamp: 1_700_000_000 + index * 60,
      }))
      .reverse();
