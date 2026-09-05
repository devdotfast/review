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
import { readReviewDocumentBundle } from "./review-bundle";
import {
  materializeReviewRevision,
  parseStoredReviewRecordForRecovery,
  readStoredReview,
} from "./review-home";
import {
  REVIEW_THREAD_DB_SCHEMA_VERSION,
  closeAllReviewThreadStores,
} from "./review-thread-store-backend";
import { readReviewSoftwareMapBundle } from "./software-map-bundle";
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
        part === ".build" ||
        part === ".native-agent" ||
        part.endsWith(".lock") ||
        part.endsWith("-shm"),
    );
}

async function sourceSnapshot(root: string): Promise<string> {
  const entries: Array<[string, string]> = [];
  async function visit(relative: string): Promise<void> {
    const absolute = path.join(root, relative);
    const entry = await lstat(absolute);
    if (entry.isSymbolicLink())
      throw new Error("Corpus copy refuses symbolic links.");
    if (entry.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) {
        const next = path.join(relative, name);
        if (included(next)) await visit(next);
      }
    } else if (entry.isFile()) {
      entries.push([
        relative,
        createHash("sha256")
          .update(await readFile(absolute))
          .digest("hex"),
      ]);
    } else {
      throw new Error("Corpus copy refuses special files.");
    }
  }
  await visit("");
  return digest(entries);
}

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
    throw new Error("Corpus source clone or pinned revision check failed.");
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
        const validated = parseStoredReviewRecordForRecovery(original);
        const commonDir = await realpath(
          await git(validated.worktreePath, [
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ]),
        );
        let clone = clones.get(commonDir);
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
        expect(record.schemaVersion).toBe(5);
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
          const out = path.join(home, "materialized", uuid, "document");
          await materializeReviewRevision(
            dir,
            loaded.review.presentedDocumentRevision,
            out,
          );
          const bundle = await readReviewDocumentBundle(out, "/");
          if (!bundle)
            throw new Error("Converted corpus document is unavailable.");
          documentBytes = Buffer.byteLength(bundle.json);
        }
        if (loaded.review.presentedSoftwareMapRevision) {
          const out = path.join(home, "materialized", uuid, "map");
          await materializeReviewRevision(
            dir,
            loaded.review.presentedSoftwareMapRevision,
            out,
          );
          const bundle = await readReviewSoftwareMapBundle(out);
          if (!bundle) throw new Error("Converted corpus map is unavailable.");
          mapBytes =
            Buffer.byteLength(bundle.headJson) +
            Buffer.byteLength(bundle.baseJson);
        }
        closeAllReviewThreadStores();
        const snapshot = await snapshotReviewTree(dir);
        const repeated = await readStoredReview(dir);
        expect("error" in repeated).toBe(false);
        expect(digest(await snapshotReviewTree(dir))).toBe(digest(snapshot));
        rows.push({
          uuid,
          schema: String(original.schemaVersion),
          status: loaded.review.status,
          documentBytes,
          mapBytes,
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
