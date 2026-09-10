import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual, promisify } from "node:util";

import {
  type JsonObject,
  type JsonValue,
  REVIEW_SCHEMA_VERSION,
  ReviewCommentAgentSessionSchema,
  isJsonObject,
  jsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { parseAuthoringSessionKey } from "./authoring-session";
import { snapshotReviewTree } from "./fixtures/legacy-reviews/legacy-review-fixture";
import {
  readReviewDocumentArtifact,
  readReviewSoftwareMapArtifact,
} from "./review-artifact-store";
import { isDerivedReviewPath } from "./review-derived-paths";
import { parseAnyStoredReviewRecord, readStoredReview } from "./review-home";
import { parsePublicationRecord } from "./review-publication-record";
import { readLegacyArtifactImport, readPublication } from "./review-state-db";
import {
  REVIEW_THREAD_DB_SCHEMA_VERSION,
  closeAllReviewThreadStores,
} from "./review-thread-store-backend";
import { migrateStoredReview } from "./stored-review-migration";

const corpus = process.env.REVIEW_LEGACY_CORPUS;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const execFilePromise = promisify(execFile);

function digest(value: JsonValue): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "undefined")
    .digest("hex");
}

function included(relative: string): boolean {
  return !relative
    .split(path.sep)
    .some(
      (part) =>
        part === ".mutation-lock" ||
        part.endsWith("-shm") ||
        (isDerivedReviewPath(part) && !/^review\.db(?:-|$)/.test(part)),
    );
}

async function sourceSnapshot(root: string): Promise<string> {
  const files = await snapshotReviewTree(root, {
    include: included,
    refuseSpecialFiles: true,
  });
  return digest(
    Object.entries(files).sort(([left], [right]) => left.localeCompare(right)),
  );
}

/** A corpus Review whose source repository is gone cannot be cloned or pinned;
 * it is reported and skipped instead of failing the whole sweep. */
class CorpusSourceUnavailable extends Error {}

async function git(root: string, args: string[]): Promise<string> {
  try {
    return (
      await execFilePromise("git", ["-C", root, ...args], {
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      })
    ).stdout.trim();
  } catch {
    throw new CorpusSourceUnavailable(
      "Corpus source clone or pinned revision check failed.",
    );
  }
}

function normalizedThread(value: JsonValue): JsonValue {
  if (!isJsonObject(value)) return value;
  if (isJsonObject(value.thread))
    return { ...value, thread: normalizedThread(value.thread) };
  const { agentSession, ...preserved } = value;
  const session =
    ReviewCommentAgentSessionSchema.strip().safeParse(agentSession);
  const normalized: JsonObject = { ...preserved };
  if (session.success) normalized.agentSession = session.data;
  if (Array.isArray(value.messages))
    normalized.messages = value.messages.map((message) => {
      if (!isJsonObject(message)) return message;
      const { native: _native, ...content } = message;
      return { ...content, agentInput: message.agentInput === true };
    });
  return normalized;
}

const ThreadRowSchema = z.object({
  thread_id: z.string(),
  record_json: z.string(),
});

function threadRows(dir: string) {
  const databasePath = path.join(dir, "review.db");
  if (!existsSync(databasePath))
    return { version: null, comments: [], drafts: [] };
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    function rows(table: "comments" | "comment_drafts") {
      return database
        .prepare(
          `SELECT thread_id, record_json FROM ${table} ORDER BY thread_id`,
        )
        .all()
        .map((row) => {
          const parsed = ThreadRowSchema.parse(row);
          return {
            threadId: parsed.thread_id,
            record: normalizedThread(parseJsonText(parsed.record_json)),
          };
        });
    }
    return {
      version:
        database
          .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
          .get()?.value ?? null,
      comments: rows("comments"),
      drafts: rows("comment_drafts"),
    };
  } finally {
    database.close();
  }
}

function preservedMetadata(record: JsonObject): JsonObject {
  const {
    schemaVersion: _schema,
    worktreePath: _root,
    sourceSession: _sourceSession,
    agentSession: _agentSession,
    agentSessions: _agentSessions,
    presentedRevision: _legacyRevision,
    presentedDocumentRevision: _document,
    presentedSoftwareMapRevision: _map,
    ...preserved
  } = record;
  return preserved;
}

describe.skipIf(!corpus)("legacy review corpus", () => {
  it("migrates isolated corpus copies without loss", async () => {
    const home = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "legacy-corpus-")),
    );
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const nativeSessionRoots: string[] = [];
    const createSourceSession: NonNullable<
      Parameters<typeof migrateStoredReview>[0]["createSourceSession"]
    > = async (input) => {
      const relative = path.relative(home, await realpath(input.rootPath));
      expect(
        relative.startsWith(`..${path.sep}`) ||
          relative === ".." ||
          path.isAbsolute(relative),
      ).toBe(false);
      nativeSessionRoots.push(input.rootPath);
      return {
        harness: input.agent.harness,
        sessionId: `corpus-${input.reviewUuid}`,
      };
    };
    const source = path.resolve(corpus!);
    const clones = new Map<string, string>();
    const originals = new Map<string, string>();
    const rows: Array<Record<string, string | number>> = [];
    const failures: string[] = [];
    try {
      const uuids = (await readdir(source))
        .filter((name) => UUID.test(name))
        .sort();
      expect(uuids.length).toBeGreaterThan(0);
      for (const uuid of uuids) {
        const sourceDir = path.join(source, uuid);
        originals.set(sourceDir, await sourceSnapshot(sourceDir));
        const dir = path.join(home, "reviews", uuid);
        let clone = "";
        await cp(sourceDir, dir, {
          recursive: true,
          filter: async (entry) => {
            if (!included(path.relative(sourceDir, entry))) return false;
            if ((await lstat(entry)).isSymbolicLink())
              throw new Error("Corpus copy refuses symbolic links.");
            return true;
          },
        });
        const recordPath = path.join(dir, "review.json");
        const original = jsonObject(
          parseJsonText(await readFile(recordPath, "utf8")),
        );
        if (!original) throw new Error("Corpus record has no source checkout.");
        const validated = parseAnyStoredReviewRecord(original);
        try {
          const commonDir = await realpath(
            await git(validated.worktreePath, [
              "rev-parse",
              "--path-format=absolute",
              "--git-common-dir",
            ]),
          );
          clone = clones.get(commonDir) ?? "";
          if (!clone) {
            clone = path.join(home, "sources", String(clones.size));
            await mkdir(path.dirname(clone), { recursive: true });
            await git(home, [
              "clone",
              "--no-hardlinks",
              "--no-checkout",
              "--config",
              "core.hooksPath=/dev/null",
              commonDir,
              clone,
            ]);
            clones.set(commonDir, clone);
          }
          for (const pin of [validated.baseCommit, validated.sourceCommit]) {
            if (pin === null || pin === undefined) continue;
            if (!/^[a-f0-9]{40}$/i.test(pin))
              throw new Error("Corpus record has an invalid pinned commit.");
            expect(
              await git(clone, ["rev-parse", "--verify", `${pin}^{commit}`]),
            ).toBe(pin);
          }
        } catch (error) {
          // A Review whose source repository no longer exists on this machine
          // is reported and skipped: it says nothing about the migration.
          if (!(error instanceof CorpusSourceUnavailable)) throw error;
          rows.push({
            uuid,
            schema: String(original.schemaVersion),
            result: "skipped-source-unavailable",
          });
          continue;
        }
        await writeFile(
          recordPath,
          `${JSON.stringify({ ...original, worktreePath: clone }, null, 2)}\n`,
        );
        const before = threadRows(dir);
        const callsBefore = nativeSessionRoots.length;
        const legacySession =
          original.schemaVersion === 2 || original.schemaVersion === 3;
        const session = parseAuthoringSessionKey(
          jsonString(original.agentSession),
        );
        const expectedSession =
          legacySession && session && validated.sourceCommit
            ? `${session.harness}:corpus-${uuid}`
            : undefined;
        if (legacySession)
          await migrateStoredReview({ reviewDir: dir, createSourceSession });
        const loaded = await readStoredReview(dir);
        if ("error" in loaded) {
          failures.push(`${uuid}: ${loaded.error.code ?? "error"}`);
          rows.push({
            uuid,
            schema: String(original.schemaVersion),
            result: loaded.error.code ?? "error",
          });
          continue;
        }
        const record = jsonObject(
          parseJsonText(JSON.stringify(loaded.review)),
        )!;
        expect(record.schemaVersion).toBe(REVIEW_SCHEMA_VERSION);
        expect(
          isDeepStrictEqual(
            preservedMetadata(record),
            preservedMetadata(original),
          ),
        ).toBe(true);
        for (const [key, session] of Object.entries(
          jsonObject(original.agentSessions) ?? {},
        ))
          expect(
            isDeepStrictEqual(jsonObject(record.agentSessions)?.[key], session),
          ).toBe(true);
        expect(nativeSessionRoots.length - callsBefore).toBe(
          expectedSession ? 1 : 0,
        );
        expect(record.sourceSession).toBe(
          legacySession
            ? (expectedSession ?? "disabled:review")
            : original.sourceSession,
        );
        const expectedSessionKeys = Object.keys(
          jsonObject(original.agentSessions) ?? {},
        );
        if (expectedSession) expectedSessionKeys.push(expectedSession);
        expect(
          Object.keys(jsonObject(record.agentSessions) ?? {}).sort(),
        ).toEqual(expectedSessionKeys.sort());
        const after = threadRows(dir);
        expect(after.version).toBe(
          before.version === null
            ? null
            : String(REVIEW_THREAD_DB_SCHEMA_VERSION),
        );
        expect(
          isDeepStrictEqual(after.comments, before.comments),
          `${uuid}: comments preserved`,
        ).toBe(true);
        expect(
          isDeepStrictEqual(after.drafts, before.drafts),
          `${uuid}: drafts preserved`,
        ).toBe(true);
        let documentBytes = 0;
        let mapBytes = 0;
        if (loaded.review.presentedDocumentRevision) {
          const row = readPublication(
            dir,
            loaded.review.presentedDocumentRevision,
            "document",
            home,
          );
          if (!row)
            throw new Error(
              `${uuid}: presented document publication ${loaded.review.presentedDocumentRevision} is missing.`,
            );
          const record = parsePublicationRecord(row.record);
          if (record.artifact.state !== "stored")
            throw new Error(
              `${uuid}: presented document artifact is unavailable (${record.artifact.reason}).`,
            );
          const bundle = await readReviewDocumentArtifact(
            dir,
            record.artifact.hash,
          );
          if (!bundle)
            throw new Error(
              `${uuid}: converted corpus document is unavailable.`,
            );
          documentBytes = Buffer.byteLength(bundle.json);
        }
        // An import may not quietly drop a presented software map: the record
        // it leaves presents one exactly when the record it read did. The
        // upgraded reading is the comparable one — schema 2 sealed a single
        // `presentedRevision` for both presentations.
        expect(
          loaded.review.presentedSoftwareMapRevision !== null,
          `${uuid}: presented software map preserved (schema ${original.schemaVersion})`,
        ).toBe(validated.presentedSoftwareMapRevision !== null);
        if (loaded.review.presentedSoftwareMapRevision) {
          const row = readPublication(
            dir,
            loaded.review.presentedSoftwareMapRevision,
            "map",
            home,
          );
          if (!row)
            throw new Error(
              `${uuid}: presented map publication ${loaded.review.presentedSoftwareMapRevision} is missing.`,
            );
          const record = parsePublicationRecord(row.record);
          if (record.artifact.state !== "stored")
            throw new Error(
              `${uuid}: presented map artifact is unavailable (${record.artifact.reason}).`,
            );
          const bundle = await readReviewSoftwareMapArtifact(
            dir,
            record.artifact.hash,
          );
          if (!bundle)
            throw new Error(`${uuid}: converted corpus map is unavailable.`);
          mapBytes =
            Buffer.byteLength(bundle.headJson) +
            Buffer.byteLength(bundle.baseJson);
        }
        const importMarker = readLegacyArtifactImport(dir, home);
        if (!importMarker)
          throw new Error(`${uuid}: legacy artifact import marker is missing.`);
        closeAllReviewThreadStores();
        const snapshot = await snapshotReviewTree(dir);
        const repeated = await readStoredReview(dir);
        expect("error" in repeated).toBe(false);
        expect(digest(await snapshotReviewTree(dir))).toBe(digest(snapshot));
        // The import reads the copy in the temp home and never the corpus.
        expect(
          await sourceSnapshot(sourceDir),
          `${uuid}: source untouched`,
        ).toBe(originals.get(sourceDir));
        rows.push({
          uuid,
          schema: String(original.schemaVersion),
          status: loaded.review.status,
          documentBytes,
          mapBytes,
          importedVersions: importMarker.versions,
          importedUnavailable: importMarker.unavailable,
          result: "ok",
        });
      }
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      expect(failures).toEqual([]);
    } finally {
      closeAllReviewThreadStores();
      warnings.mockRestore();
      vi.unstubAllEnvs();
      try {
        for (const [sourceDir, snapshot] of originals)
          expect(await sourceSnapshot(sourceDir)).toBe(snapshot);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  }, 300_000);
});
