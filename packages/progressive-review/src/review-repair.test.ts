import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Writable } from "node:stream";

import { remoteNotesRef, writeNote } from "@dev.fast/local-vcs";
import { REVIEW_SCHEMA_VERSION, jsonObject } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sealLegacyReviewCommit } from "./fixtures/legacy-reviews/legacy-review-git";
import { readReviewDocumentArtifact } from "./review-artifact-store";
import {
  bundleReviewDocument,
  writeReviewDocumentBundle,
} from "./review-bundle";
import { createReviewDir, readStoredReview } from "./review-home";
import { startLifecycleTestServer } from "./review-lifecycle-test-utils";
import { parsePublicationRecord } from "./review-publication-record";
import { runReviewRepair } from "./review-repair";
import {
  type ReviewRepairCandidate,
  prepareReviewRepair,
  repairSourceFallback,
} from "./review-repair-preparation";
import { fingerprintReviewRepairInputs } from "./review-repair-state";
import {
  deleteReviewState,
  listPublications,
  putReviewRecord,
  readPublication,
  readReviewRecord,
} from "./review-state-db";
import { appendReviewComment } from "./review-state-store";
import { SOFTWARE_MAP_NOTES_REF } from "./review-storage";
import {
  closeAllReviewThreadStores,
  copyReviewThreadDatabaseSnapshot,
  createLegacyReviewThreadDb,
  readReviewThreadsReadOnly,
} from "./review-thread-store-backend";
import { applyPreparedReviewRepair } from "./server/review-repair-promotion";
import {
  bundleReviewSoftwareMap,
  writeReviewSoftwareMapBundle,
} from "./software-map-bundle";
import { defineSoftwareMap } from "./software-map-model";

const roots: string[] = [];
let server: Awaited<ReturnType<typeof startLifecycleTestServer>> | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  closeAllReviewThreadStores();
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

interface FixtureOptions {
  /** Seal a v1 JavaScript bundle at schema 4 instead of a v2 JSON one. */
  legacy?: boolean;
  /** Read the Review once so its Git-era publication becomes a row. */
  imported?: boolean;
}

async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-repair-test-"));
  roots.push(root);
  const source = path.join(root, "source");
  await mkdir(source);
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.com"],
    ["commit", "--allow-empty", "-m", "Initial"],
  ])
    execFileSync("git", args, { cwd: source, stdio: "ignore" });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: source,
    encoding: "utf8",
  }).trim();
  const stored = await createReviewDir({
    reviewsHomePath: path.join(root, "home"),
    worktreePath: source,
    baseRef: "main",
    baseCommit: commit,
    sourceCommit: commit,
    sourceIdentity: { kind: "git-branch", name: "main" },
  });
  if (options.legacy) {
    const bundle = path.join(stored.dir, ".bundle/document");
    await mkdir(bundle, { recursive: true });
    await writeFile(
      path.join(bundle, "manifest.json"),
      JSON.stringify({ version: 1 }),
    );
    await writeFile(
      path.join(bundle, "review-document.js"),
      'import {createActiveReviewDocument,jsx} from "review-doc-runtime"; export default createActiveReviewDocument({title:"Sealed",routePath:"/",filePath:"review.mdx",models:{},modelNames:[],Component:()=>jsx("h1",{children:"Sealed"}),isDefault:true});',
    );
  } else await writeReviewDocumentBundle(stored.dir, readyDocument());
  const revision = await sealLegacyReviewCommit(stored.dir, "Presented");
  const record = {
    ...stored.review,
    schemaVersion: options.legacy ? 4 : REVIEW_SCHEMA_VERSION,
    status: "accepted",
    presentedDocumentRevision: revision,
    dismissedAt: "2026-09-01T00:00:00.000Z",
  };
  await writeFile(path.join(stored.dir, "review.json"), JSON.stringify(record));
  // The database row from createReviewDir predates the presentation this
  // fixture writes directly to the mirror; drop it so repair reads the file.
  deleteReviewState(stored.dir);
  if (options.imported) await readStoredReview(stored.dir);
  return { ...stored, record, revision };
}

function readyDocument() {
  return bundleReviewDocument({
    format: "review-document/1",
    title: "Ready",
    routePath: "/",
    sourcePath: "review.mdx",
    body: [],
    anchors: {},
    anchorContents: {},
    softwareModels: [],
  });
}

async function prepared(
  reviewDir: string,
  warning?: (message: string) => void,
): Promise<ReviewRepairCandidate> {
  const result = await prepareReviewRepair(
    warning ? { reviewDir, warning } : { reviewDir },
  );
  if (result.kind !== "prepared") throw new Error("Expected a prepared repair");
  return result.candidate;
}

/** Drops the stored bytes a publication references without touching its row,
 * which is exactly the damage `review repair` exists to undo. */
async function dropStoredArtifacts(
  reviewDir: string,
  kind: "documents" | "maps",
) {
  await rm(path.join(reviewDir, "artifacts", kind), {
    recursive: true,
    force: true,
  });
}

describe("prepareReviewRepair", () => {
  it("returns a healthy no-op without changing a terminal review", async () => {
    const stored = await fixture({ imported: true });
    const before = await readFile(path.join(stored.dir, "review.json"), "utf8");
    const result = await prepareReviewRepair({ reviewDir: stored.dir });
    expect(result.kind).toBe("noop");
    expect(await readFile(path.join(stored.dir, "review.json"), "utf8")).toBe(
      before,
    );
  });

  it("directs an unpresented draft to publish", async () => {
    const stored = await fixture();
    await writeFile(
      path.join(stored.dir, "review.json"),
      JSON.stringify({
        ...stored.record,
        status: "draft",
        presentedDocumentRevision: null,
      }),
    );
    await expect(
      prepareReviewRepair({ reviewDir: stored.dir }),
    ).rejects.toThrow(/publish/);
  });

  it("converts a sealed terminal document in isolation without editable inputs", async () => {
    const stored = await fixture({ legacy: true });
    await rm(path.join(stored.dir, "review.mdx"));
    await rm(path.join(stored.dir, "data.ts"));
    const before = await readFile(path.join(stored.dir, "review.json"), "utf8");
    const candidate = await prepared(stored.dir);
    try {
      expect(repairSourceFallback(candidate)).toEqual({
        document: false,
        map: false,
      });
      expect(candidate.document).toEqual({
        kind: "unchanged",
        publicationId: stored.revision,
      });
      expect(candidate.next).toMatchObject({
        status: "accepted",
        dismissedAt: stored.record.dismissedAt,
        schemaVersion: REVIEW_SCHEMA_VERSION,
        presentedDocumentRevision: stored.revision,
      });
      // The converted bytes are installed but nothing points at them yet.
      const row = candidate.legacyImport?.publications.find(
        (entry) => entry.publicationId === stored.revision,
      );
      expect(row?.record.artifact).toMatchObject({ state: "stored" });
      expect(listPublications(stored.dir, "document")).toEqual([]);
      expect(await readFile(path.join(stored.dir, "review.json"), "utf8")).toBe(
        before,
      );
    } finally {
      await candidate.cleanup();
    }
  });

  it("uses editable sources only after sealed conversion fails and preserves the real candidate", async () => {
    const stored = await fixture({ legacy: true });
    await writeFile(
      path.join(stored.dir, ".bundle/document/review-document.js"),
      "broken javascript",
    );
    const revision = await sealLegacyReviewCommit(
      stored.dir,
      "Broken current artifact",
    );
    await writeFile(
      path.join(stored.dir, "review.json"),
      JSON.stringify({ ...stored.record, presentedDocumentRevision: revision }),
    );
    await writeFile(
      path.join(stored.dir, "review.mdx"),
      "# Repaired presentation\n",
    );
    const before = await fingerprintReviewRepairInputs(stored.dir);
    const warnings: string[] = [];
    const candidate = await prepared(stored.dir, (message) =>
      warnings.push(message),
    );
    try {
      expect(repairSourceFallback(candidate).document).toBe(true);
      expect(warnings.join(" ")).toContain("semantic equivalence");
      // The rebuilt row stands beside the unconvertible one it replaces.
      expect(candidate.document).toEqual({
        kind: "unchanged",
        publicationId: candidate.legacyImport?.activeDocumentId,
      });
      expect(candidate.document).not.toEqual({
        kind: "unchanged",
        publicationId: revision,
      });
      expect(await fingerprintReviewRepairInputs(stored.dir)).toBe(before);
    } finally {
      await candidate.cleanup();
    }
  });

  it("reports missing sealed and editable inputs without changing private state", async () => {
    const stored = await fixture({ imported: true });
    await dropStoredArtifacts(stored.dir, "documents");
    await rm(path.join(stored.dir, ".git"), { recursive: true });
    await rm(path.join(stored.dir, "review.mdx"));
    const before = await fingerprintReviewRepairInputs(stored.dir);
    await expect(
      prepareReviewRepair({ reviewDir: stored.dir }),
    ).rejects.toThrow(
      `Missing editable Review input: ${path.join(stored.dir, "review.mdx")}`,
    );
    expect(await fingerprintReviewRepairInputs(stored.dir)).toBe(before);
  });

  it("rebuilds a lost document artifact from the revision its row records", async () => {
    const stored = await fixture({ imported: true });
    const documentId = stored.revision;
    await dropStoredArtifacts(stored.dir, "documents");
    const candidate = await prepared(stored.dir);
    try {
      if (candidate.document.kind !== "replace")
        throw new Error("Expected a replaced document");
      expect(candidate.legacyImport).toBeUndefined();
      expect(candidate.document.usedEditableSources).toBe(false);
      expect(candidate.document.bundle.json).toBe(readyDocument().json);
      // The replacement keeps the pinned code context of the row it replaces.
      const previous = parsePublicationRecord(
        readPublication(stored.dir, documentId, "document")!.record,
      );
      expect(candidate.document.candidate.context).toEqual({
        baseRef: previous.baseRef,
        baseCommit: previous.baseCommit,
        sourceCommit: previous.sourceCommit,
        sourceIdentity: previous.sourceIdentity,
      });
      expect(
        await readReviewDocumentArtifact(
          stored.dir,
          candidate.document.candidate.artifactHash,
        ),
      ).not.toBeNull();
    } finally {
      await candidate.cleanup();
    }
  });

  it("keeps an independent valid map pointer during document conversion", async () => {
    const stored = await fixture({ legacy: true });
    const model = defineSoftwareMap({ systems: { app: { label: "App" } } });
    await writeReviewSoftwareMapBundle(
      stored.dir,
      bundleReviewSoftwareMap({
        head: model,
        base: model,
        headCommit: stored.review.sourceCommit!,
        baseCommit: stored.review.baseCommit,
      }),
    );
    const mapRevision = await sealLegacyReviewCommit(
      stored.dir,
      "Independent JSON map",
    );
    await writeFile(
      path.join(stored.dir, "review.json"),
      JSON.stringify({
        ...stored.record,
        presentedSoftwareMapRevision: mapRevision,
      }),
    );
    const candidate = await prepared(stored.dir);
    try {
      expect(candidate.map).toEqual({
        kind: "unchanged",
        publicationId: mapRevision,
      });
    } finally {
      await candidate.cleanup();
    }
  });

  it("repairs only a legacy map while preserving the healthy document pointer", async () => {
    const stored = await fixture();
    const model = defineSoftwareMap({ systems: { app: { label: "App" } } });
    const mapDir = path.join(stored.dir, ".bundle/software-map");
    await mkdir(mapDir, { recursive: true });
    await writeFile(
      path.join(mapDir, "manifest.json"),
      JSON.stringify({
        version: 1,
        headCommit: stored.review.sourceCommit,
        baseCommit: stored.review.baseCommit,
      }),
    );
    const code = `const elements = ${JSON.stringify(model.elements)}; const relationships = ${JSON.stringify(model.relationships)}; const elementsByPath = new Map(elements.map(element => [element.path, element])); export default {elements,relationships,elementsByPath};`;
    await writeFile(path.join(mapDir, "head-map.js"), code);
    await writeFile(path.join(mapDir, "base-map.js"), code);
    const mapRevision = await sealLegacyReviewCommit(
      stored.dir,
      "Legacy map only",
    );
    await writeFile(
      path.join(stored.dir, "review.json"),
      JSON.stringify({
        ...stored.record,
        presentedSoftwareMapRevision: mapRevision,
      }),
    );
    await readStoredReview(stored.dir);
    await dropStoredArtifacts(stored.dir, "maps");
    const before = await fingerprintReviewRepairInputs(stored.dir);
    const candidate = await prepared(stored.dir);
    try {
      expect(candidate.document).toEqual({
        kind: "unchanged",
        publicationId: stored.revision,
      });
      if (candidate.map.kind !== "replace")
        throw new Error("Expected a replaced software map");
      expect(candidate.map.usedEditableSources).toBe(false);
      expect(candidate.map.candidate).toMatchObject({
        operation: "repair",
        headCommit: stored.review.sourceCommit,
        baseCommit: stored.review.baseCommit,
      });
      expect(repairSourceFallback(candidate)).toEqual({
        document: false,
        map: false,
      });
      expect(await fingerprintReviewRepairInputs(stored.dir)).toBe(before);
    } finally {
      await candidate.cleanup();
    }
  });

  it("repairs from validated remote saved map notes without backfilling source refs", async () => {
    const stored = await fixture({ imported: true });
    await writeNote({
      rootPath: stored.review.worktreePath,
      ref: remoteNotesRef(SOFTWARE_MAP_NOTES_REF),
      commit: stored.review.sourceCommit!,
      content:
        'import {defineSoftwareMap} from "@dev.fast/progressive-review/software-map-model"; export default defineSoftwareMap({systems:{app:{label:"App"}}});',
    });
    presentMissingSoftwareMap(stored.dir);
    const refs = () =>
      execFileSync("git", ["show-ref"], {
        cwd: stored.review.worktreePath,
        encoding: "utf8",
      });
    const before = refs();
    const candidate = await prepared(stored.dir);
    try {
      expect(candidate.document).toEqual({
        kind: "unchanged",
        publicationId: stored.revision,
      });
      expect(repairSourceFallback(candidate)).toEqual({
        document: false,
        map: true,
      });
      expect(refs()).toBe(before);
    } finally {
      await candidate.cleanup();
    }
  });

  it("does not promote a prepared document when a broken map has no saved notes", async () => {
    const stored = await fixture({ imported: true });
    presentMissingSoftwareMap(stored.dir);
    const before = await fingerprintReviewRepairInputs(stored.dir);
    await expect(
      prepareReviewRepair({ reviewDir: stored.dir }),
    ).rejects.toThrow(/Software map repair failed/);
    expect(await fingerprintReviewRepairInputs(stored.dir)).toBe(before);
  });

  it("rejects contradictory sealed map pins instead of selecting one", async () => {
    const stored = await fixture();
    const model = defineSoftwareMap({ systems: { app: { label: "App" } } });
    await writeReviewSoftwareMapBundle(
      stored.dir,
      bundleReviewSoftwareMap({
        base: model,
        head: model,
        baseCommit: stored.review.baseCommit,
        headCommit: "d".repeat(40),
      }),
    );
    const mapRevision = await sealLegacyReviewCommit(
      stored.dir,
      "Contradictory map pins",
    );
    await writeFile(
      path.join(stored.dir, "review.json"),
      JSON.stringify({
        ...stored.record,
        presentedSoftwareMapRevision: mapRevision,
      }),
    );
    const before = await fingerprintReviewRepairInputs(stored.dir);
    await expect(
      prepareReviewRepair({ reviewDir: stored.dir }),
    ).rejects.toThrow(/contradict/);
    expect(await fingerprintReviewRepairInputs(stored.dir)).toBe(before);
  });

  it("prepares a metadata-only legacy upgrade without changing healthy JSON pointers", async () => {
    const stored = await fixture();
    await writeFile(
      path.join(stored.dir, "review.json"),
      JSON.stringify({ ...stored.record, schemaVersion: 4 }),
    );
    const candidate = await prepared(stored.dir);
    try {
      expect(candidate.storedSchemaVersion).toBe(4);
      expect(candidate.document).toEqual({
        kind: "unchanged",
        publicationId: stored.revision,
      });
      expect(candidate.map).toEqual({ kind: "unchanged", publicationId: null });
      expect(candidate.next.schemaVersion).toBe(REVIEW_SCHEMA_VERSION);
      expect(candidate.legacyImport?.versions).toBe(1);
    } finally {
      await candidate.cleanup();
    }
  });

  it("requires an explicit UUID before looking up a review", async () => {
    let output = "";
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    expect(
      await runReviewRepair({
        cwd: process.cwd(),
        stdout,
        stderr: stdout,
        json: true,
      }),
    ).toBe(1);
    expect(output).toContain("explicit UUID");
  });

  it("keeps the human report on stderr under --json and refuses another checkout", async () => {
    const stored = await fixture({ imported: true });
    vi.stubEnv("DEV_REVIEW_HOME", path.dirname(path.dirname(stored.dir)));
    server = await startLifecycleTestServer();
    const out = collect();
    const err = collect();
    expect(
      await runReviewRepair({
        cwd: path.join(path.dirname(stored.dir), "elsewhere"),
        reviewUuid: stored.review.uuid,
        json: true,
        stdout: out.stream,
        stderr: err.stream,
        env: { DEV_REVIEW_HOME: "/not-the-desktop-home" },
      }),
    ).toBe(1);
    expect(out.text()).toContain('"event":"error"');
    expect(err.text()).toContain(stored.review.uuid);
    expect(out.text()).not.toContain("Review repaired:");
  });

  it("uses desktop-owned storage instead of the caller environment", async () => {
    const stored = await fixture({ imported: true });
    vi.stubEnv("DEV_REVIEW_HOME", path.dirname(path.dirname(stored.dir)));
    server = await startLifecycleTestServer();
    const out = collect();
    const err = collect();
    const originalDevReviewHome = process.env.DEV_REVIEW_HOME;
    expect(
      await runReviewRepair({
        cwd: stored.review.worktreePath,
        reviewUuid: stored.review.uuid,
        json: true,
        stdout: out.stream,
        stderr: err.stream,
        env: { DEV_REVIEW_HOME: "/not-the-desktop-home" },
      }),
    ).toBe(0);
    expect(out.text()).toContain('"event":"repaired"');
    expect(err.text()).toContain(
      "Current Review artifacts are healthy; no repair needed.",
    );
    expect(process.env.DEV_REVIEW_HOME).toBe(originalDevReviewHome);
  });
});

/** Points the record at a software map no row and no revision answers. */
function presentMissingSoftwareMap(reviewDir: string) {
  const record = jsonObject(readReviewRecord(reviewDir));
  if (!record) throw new Error("Expected a stored Review record");
  putReviewRecord(reviewDir, {
    ...record,
    presentedSoftwareMapRevision: "e".repeat(40),
  });
}

function collect() {
  let text = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        text += chunk.toString();
        callback();
      },
    }),
    text: () => text,
  };
}

it("repairs broken sealed artifacts with a legacy DB by upgrading only the isolated thread snapshot", async () => {
  const stored = await legacyThreadDatabaseFixture();
  const candidate = await prepared(stored.dir);
  try {
    expect(repairSourceFallback(candidate).document).toBe(true);
    expect(candidate.expectedThreadDbFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(candidate.upgradedThreadDb).toBeDefined();
    expect(await readFile(stored.dbPath)).toEqual(stored.bytes);
    const upgraded = candidate.upgradedThreadDb!.dir;
    for (const suffix of ["-wal", "-shm"])
      await expect(
        readFile(path.join(upgraded, `review.db${suffix}`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      readReviewThreadsReadOnly(path.join(upgraded, "review.mdx")).comments.kept
        ?.messages[0]?.body,
    ).toBe("Preserved comment");
  } finally {
    await candidate.cleanup();
  }
});

it("refuses to promote a repair after the legacy thread database changes", async () => {
  const stored = await legacyThreadDatabaseFixture();
  const record = await readFile(path.join(stored.dir, "review.json"), "utf8");
  const candidate = await prepared(stored.dir);
  try {
    // The guard the isolated upgrade arms: a write to the Review's own legacy
    // thread database between preparation and promotion refuses the promotion.
    expect(candidate.expectedThreadDbFingerprint).toMatch(/^[0-9a-f]{64}$/);
    const writer = new DatabaseSync(stored.dbPath);
    writer.exec(
      "INSERT OR REPLACE INTO meta(key,value) VALUES ('concurrent-write','changed')",
    );
    writer.close();

    await expect(
      applyPreparedReviewRepair(stored.dir, candidate),
    ).rejects.toThrow("Review threads changed while preparing repair");

    expect(await readFile(path.join(stored.dir, "review.json"), "utf8")).toBe(
      record,
    );
    expect(listPublications(stored.dir, "document")).toEqual([]);
  } finally {
    await candidate.cleanup();
  }
});

it("rejects changes to legacy threads while preparing artifact repair", async () => {
  const stored = await fixture({ legacy: true });
  createLegacyReviewThreadDb(stored.dir);
  deleteReviewState(stored.dir);
  const dbPath = path.join(stored.dir, "review.db");
  const db = new DatabaseSync(dbPath);
  db.exec("UPDATE meta SET value = '5' WHERE key = 'schema_version'");
  db.close();
  await writeFile(
    path.join(stored.dir, ".bundle/document/review-document.js"),
    "throw new Error('broken sealed');",
  );
  const broken = await sealLegacyReviewCommit(
    stored.dir,
    "Broken sealed document",
  );
  await writeFile(
    path.join(stored.dir, "review.json"),
    JSON.stringify({ ...stored.record, presentedDocumentRevision: broken }),
  );
  await expect(
    prepareReviewRepair({
      reviewDir: stored.dir,
      warning: () => {
        const writer = new DatabaseSync(dbPath);
        writer.exec(
          "INSERT OR REPLACE INTO meta(key,value) VALUES ('concurrent-write','changed')",
        );
        writer.close();
      },
    }),
  ).rejects.toThrow("Review threads changed while preparing repair");
});

/** A Review repaired before it is ever read: its threads still live in its own
 * legacy `review.db`, and its sealed document cannot be converted. */
async function legacyThreadDatabaseFixture() {
  const stored = await fixture({ legacy: true });
  appendReviewComment(path.join(stored.dir, "review.mdx"), {
    threadId: "kept",
    messageId: "message",
    target: { kind: "document" },
    body: "Preserved comment",
    author: "Reviewer",
  });
  closeAllReviewThreadStores();
  const dbPath = path.join(stored.dir, "review.db");
  const document = path.join(stored.dir, "review.mdx");
  copyReviewThreadDatabaseSnapshot(document, document);
  deleteReviewState(stored.dir);
  const db = new DatabaseSync(dbPath);
  db.exec("UPDATE meta SET value = '5' WHERE key = 'schema_version'");
  db.close();
  const bytes = await readFile(dbPath);
  await writeFile(
    path.join(stored.dir, ".bundle/document/review-document.js"),
    "throw new Error('broken sealed');",
  );
  const broken = await sealLegacyReviewCommit(
    stored.dir,
    "Broken sealed document",
  );
  await writeFile(
    path.join(stored.dir, "review.json"),
    JSON.stringify({ ...stored.record, presentedDocumentRevision: broken }),
  );
  return { ...stored, dbPath, bytes };
}
