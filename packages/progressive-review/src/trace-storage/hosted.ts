import path from "node:path";

import { git } from "@dev.fast/local-vcs";
import { type SessionMeta, commitShaSchema } from "@dev.fast/review-protocol";
import {
  type CompleteUploadResponse,
  MAX_TRACE_COMMITS,
  MAX_TRACE_OBJECTS,
  type TraceObjectName,
  traceObjectNameSchema,
  uploadManifestMismatch,
} from "@dev.fast/trace-shared";

import { devReviewHome } from "../review-storage";
import { readStoreAuth } from "../store-auth";
import { StoreApiError, StoreClient } from "../store-client";
import { traceRepoName } from "../trace-repo";
import {
  type TraceRepositoryTarget,
  isStoreUnreachable,
  readCachedTraceRepositoryTarget,
  requireTraceConsent,
  resolveTraceRepositoryTarget,
  traceTargetKey,
} from "../trace-repository-target";
import { requireTraceSessionProvenance } from "../trace-session-provenance";
import {
  type TraceStoreSession,
  type TraceStoreTransport,
  createHttpTraceStoreTransport,
  gzipToTemp,
} from "../trace-store-transport";
import { clearTraceSyncFailure } from "../trace-sync-status";
import type {
  HostedStorageTarget,
  TraceCommitAssociation,
  TraceCommitSessions,
  TraceObjectInfo,
  TracePublishInput,
  TracePublishResult,
  TraceStorage,
  TraceStorageReadiness,
} from "./types";
import { TraceStorageDeniedError, TraceStorageUnavailableError } from "./types";

/**
 * The hosted trace store: authorization and metadata through the hosted
 * API, object bytes through signed S3 transfers. Owns upload ids, manifests,
 * atomic completion, and server-side commit associations.
 */

export type TraceStoreWarning = (message: string) => void;

function defaultWarning(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * One line that names why a store read failed, or null when the answer
 * means the store simply holds nothing for this repository or session.
 */
function storeReadWarning(error: Error): string | null {
  if (error instanceof StoreApiError) {
    if (error.code === "not_found") return null;
    if (error.code === "unauthorized") {
      return "Trace store request failed: unauthorized. Run `review login`.";
    }
    if (error.code === "forbidden") {
      return `Trace store request failed: forbidden. ${error.message}`;
    }
    return `Trace store request failed: ${error.message}`;
  }
  return `Trace store request failed: ${error.message}`;
}

/** What the store said about one session. */
type StoreSessionLookup =
  | { status: "found"; session: TraceStoreSession }
  /** The store answered and holds no such session. */
  | { status: "absent" }
  /** The store answered and refused: forbidden, deleted, or a bad login. */
  | { status: "denied"; error: Error }
  /** The store did not answer, or the access is offline. */
  | { status: "unreachable"; error: Error | null };

export interface ResolveHostedStorageInput {
  cwd: string;
  origin: string;
  /** A write never uses a saved target and needs a login. */
  write: boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  client?: StoreClient;
  transport?: TraceStoreTransport;
  onWarning?: TraceStoreWarning;
}

export interface HostedStorageParts {
  target: TraceRepositoryTarget;
  transport: TraceStoreTransport;
  devHome?: string;
  offline?: boolean;
  onWarning?: TraceStoreWarning;
}

/** The object name the store uses for one trace of a session. */
export function traceObjectName(traceName: string): TraceObjectName {
  if (traceName === "main") return "main.jsonl.gz";
  const base = path.basename(traceName);
  const fileName = base.endsWith(".jsonl") ? base : `${base}.jsonl`;
  return `subagents/${fileName}.gz`;
}

/** The trace name behind one store object name. */
function traceNameFromObject(name: string): string {
  if (name === "main.jsonl.gz") return "main";
  return name.slice("subagents/".length, -".jsonl.gz".length);
}

function contentId(session: TraceStoreSession, sha256: string): string {
  return `sha256:${sha256}@${session.generation}`;
}

export class HostedTraceStorage implements TraceStorage {
  readonly kind = "hosted" as const;
  readonly target: HostedStorageTarget;
  readonly repositoryTarget: TraceRepositoryTarget;
  readonly offline: boolean;
  private readonly transport: TraceStoreTransport;
  private readonly devHome: string;
  private readonly warn: TraceStoreWarning;
  /** One listing per session per instance; an instance lives one operation. */
  private readonly lookups = new Map<string, Promise<StoreSessionLookup>>();

  private constructor(parts: HostedStorageParts) {
    this.repositoryTarget = parts.target;
    this.target = { kind: "hosted", ...parts.target };
    this.transport = parts.transport;
    this.offline = parts.offline ?? false;
    this.devHome = parts.devHome ?? devReviewHome();
    this.warn = parts.onWarning ?? defaultWarning;
  }

  /** A storage over an already resolved target; tests use a memory transport. */
  static fromParts(parts: HostedStorageParts): HostedTraceStorage {
    return new HostedTraceStorage(parts);
  }

  /**
   * The store for this checkout, or null when no store answers for it. A
   * reader needs no consent entry: a login plus GitHub push access is enough
   * and the store enforces that. Without a login, or when the store does
   * not answer, the target this checkout resolved to earlier serves the
   * saved copies with `offline: true`. A write never falls back.
   */
  static async resolve(
    input: ResolveHostedStorageInput,
  ): Promise<HostedTraceStorage | null> {
    const env = input.env ?? process.env;
    const devHome = devReviewHome(env, input.homeDir);
    const report = input.onWarning ?? defaultWarning;
    const origin = input.origin;

    if (input.write) {
      // A publication goes to the selected origin only. A login for another
      // origin is not a client for this one.
      let client = input.client;
      if (!client) {
        const auth = await readStoreAuth(env);
        if (!auth || auth.origin !== origin) {
          throw new Error(
            auth
              ? `You are logged in to ${auth.origin}, not the selected store ${origin}. Run \`review login --origin ${origin}\`.`
              : `The trace store login is missing. Run \`review login --origin ${origin}\`.`,
          );
        }
        client = new StoreClient({ origin, token: auth.token });
      }
      const { target } = await resolveTraceRepositoryTarget({
        cwd: input.cwd,
        origin,
        client,
        write: true,
        devHome,
      });
      return new HostedTraceStorage({
        target,
        transport: input.transport ?? createHttpTraceStoreTransport(client),
        devHome,
        onWarning: input.onWarning,
      });
    }

    const auth = await readStoreAuth(env);
    const client =
      input.client ??
      (auth && auth.origin === origin
        ? new StoreClient({ origin, token: auth.token })
        : undefined);
    if (!client) {
      // No usable login. The saved target still names the copies this
      // checkout may read while it is offline; the transport is never asked.
      if (auth && auth.origin !== origin) {
        report(
          `You are logged in to ${auth.origin}, not the selected store ${origin}. Run \`review login --origin ${origin}\`; using saved copies until then.`,
        );
      }
      const cached = await readCachedTraceRepositoryTarget({
        cwd: input.cwd,
        origin,
        devHome,
      }).catch(() => null);
      if (!cached) return null;
      return new HostedTraceStorage({
        target: cached,
        transport:
          input.transport ??
          createHttpTraceStoreTransport(new StoreClient({ origin })),
        devHome,
        offline: true,
        onWarning: input.onWarning,
      });
    }

    try {
      const { target, offline } = await resolveTraceRepositoryTarget({
        cwd: input.cwd,
        origin,
        client,
        write: false,
        devHome,
      });
      if (offline) {
        report(
          "The trace store did not answer. Using the saved copies of this repository.",
        );
      }
      return new HostedTraceStorage({
        target,
        transport: input.transport ?? createHttpTraceStoreTransport(client),
        devHome,
        offline,
        onWarning: input.onWarning,
      });
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      if (
        cause instanceof StoreApiError &&
        (cause.code === "unauthorized" ||
          cause.code === "forbidden" ||
          cause.code === "store_deleted")
      ) {
        // The store answered and refused. Nothing saved may pass as current.
        throw new TraceStorageDeniedError(cause.message);
      }
      // A missing store is a setup problem the user can fix, so it is named.
      const message =
        cause instanceof StoreApiError && cause.code === "not_found"
          ? cause.message
          : storeReadWarning(cause);
      if (message) report(message);
      return null;
    }
  }

  cacheIdentity(): string {
    return `hosted:${traceTargetKey(this.repositoryTarget)}:${this.repositoryTarget.storeId}`;
  }

  cacheScope() {
    const [originKey, repositoryKey] = traceTargetKey(
      this.repositoryTarget,
    ).split("/");
    return { owner: originKey, repo: repositoryKey };
  }

  async readiness(): Promise<TraceStorageReadiness> {
    if (this.offline) {
      return {
        ready: false,
        reason:
          "The trace store did not answer. Saved copies are served offline.",
      };
    }
    return { ready: true };
  }

  async describeObject(
    sessionId: string,
    traceName: string,
  ): Promise<TraceObjectInfo | null> {
    const stored = await this.requireSession(sessionId);
    if (!stored) return null;
    const object = stored.objects.find(
      (entry) => entry.name === traceObjectName(traceName),
    );
    if (!object) return null;
    return { size: object.size, contentId: contentId(stored, object.sha256) };
  }

  async downloadObject(
    sessionId: string,
    traceName: string,
    destinationPath: string,
  ): Promise<TraceObjectInfo | null> {
    const stored = await this.requireSession(sessionId);
    if (!stored) return null;
    const object = stored.objects.find(
      (entry) => entry.name === traceObjectName(traceName),
    );
    if (!object) return null;
    // The transport verifies size and checksum before the file appears.
    await this.transport.getObject(object, destinationPath);
    return { size: object.size, contentId: contentId(stored, object.sha256) };
  }

  async listSubagents(sessionId: string): Promise<string[]> {
    const lookup = await this.lookupSession(sessionId);
    if (lookup.status !== "found") return [];
    return lookup.session.objects
      .filter((object) => object.name !== "main.jsonl.gz")
      .map((object) => traceNameFromObject(object.name))
      .sort();
  }

  /**
   * The store's record of one session, in the shape the bucket's meta.json
   * has: repository, commits, branch, author, and last update. The store
   * keeps no pull request number, so that stays null.
   */
  async sessionMeta(sessionId: string): Promise<SessionMeta | null> {
    const stored = await reachableSession(() => this.requireSession(sessionId));
    if (!stored) return null;
    return {
      session: stored.sessionId,
      repo: this.repositoryTarget.name,
      branch: stored.branch ?? null,
      pr: null,
      commits: [...stored.commits],
      author: stored.author ?? null,
      ts: stored.updatedAt,
    };
  }

  async sessionsForCommit(commit: string): Promise<TraceCommitSessions | null> {
    if (this.offline) return null;
    if (!commitShaSchema.safeParse(commit).success) return null;
    try {
      const sessions: string[] = [];
      let cursor: string | undefined;
      // A bounded walk: ten pages of the server's default size.
      for (let page = 0; page < MAX_COMMIT_LISTING_PAGES; page += 1) {
        const response = await this.transport.listSessions(
          this.repositoryTarget.repositoryId,
          cursor === undefined ? { commit } : { commit, cursor },
        );
        sessions.push(...response.sessions.map((session) => session.sessionId));
        if (!response.nextCursor) break;
        cursor = response.nextCursor;
      }
      return sessions.length > 0 ? { sessions, pr: null, branch: null } : null;
    } catch (error) {
      this.reportFailure(
        error instanceof Error ? error : new Error(String(error)),
      );
      return null;
    }
  }

  /**
   * Publishes one stable session snapshot. Consent and provenance are
   * settled before any transcript is compressed, so nothing is sent for a
   * session that may not leave the machine.
   */
  async publish(input: TracePublishInput): Promise<TracePublishResult> {
    const target = this.repositoryTarget;
    const expected = traceRepoName(input.repo);
    if (expected.toLowerCase() !== target.name.toLowerCase()) {
      throw new Error(
        `This checkout is ${target.name}, not ${expected}. A session is published only to its own repository's store.`,
      );
    }
    await requireTraceConsent(target, this.devHome);
    await requireTraceSessionProvenance(input.sessionId, target, this.devHome);

    // The store names every object and takes at most MAX_TRACE_OBJECTS of
    // them. A subagent past that limit, or one whose name the store rejects,
    // stays on the machine and is reported as omitted.
    const files: Array<{ name: TraceObjectName; path: string }> = [];
    const omittedSubagents: string[] = [];
    for (const file of input.files) {
      const name = traceObjectName(file.name);
      if (
        file.name !== "main" &&
        (files.length >= MAX_TRACE_OBJECTS ||
          !traceObjectNameSchema.safeParse(name).success)
      ) {
        omittedSubagents.push(file.name.replace(/\.jsonl$/, ""));
        continue;
      }
      files.push({ name, path: file.path });
    }

    const compressed: Array<{
      name: TraceObjectName;
      size: number;
      sha256: string;
      path: string;
      cleanup: () => Promise<void>;
    }> = [];
    try {
      // One gzip pass per file fixes the bytes this attempt uploads. The
      // manifest below describes exactly those bytes.
      for (const file of files) {
        const gzipped = await gzipToTemp(file.path);
        compressed.push({ name: file.name, ...gzipped });
      }
      const manifest = compressed.map((object) => ({
        name: object.name,
        size: object.size,
        sha256: object.sha256,
      }));
      const allCommits = [
        ...new Set(
          input.commits?.filter(
            (commit) => commitShaSchema.safeParse(commit).success,
          ) ?? (await commitsForTraceSession(input.cwd, input.sessionId)),
        ),
      ];
      const commits = allCommits.slice(0, MAX_TRACE_COMMITS);
      const omitted = {
        subagents: omittedSubagents,
        commits: allCommits.length - commits.length,
      };
      const labels = { branch: input.branch, author: input.author };

      // The published upload already holds these exact bytes: link any new
      // commits to it and send nothing. Completing the current upload again
      // is additive for commits and returns its receipt.
      this.lookups.delete(input.sessionId);
      const current = await this.lookupSession(input.sessionId);
      if (
        current.status === "found" &&
        sameObjects(manifest, current.session.objects)
      ) {
        const completed = await this.completeUploadOnce(
          input.sessionId,
          current.session.uploadId,
          commits,
          labels,
        );
        this.lookups.delete(input.sessionId);
        await clearTraceSyncFailure(input.sessionId, this.devHome).catch(
          () => undefined,
        );
        return publishResult(
          compressed,
          "unchanged",
          target,
          completed,
          omitted,
        );
      }

      const begun = await this.transport.beginUpload(
        target.repositoryId,
        input.sessionId,
        { harness: input.harness, objects: manifest },
      );
      if (begun.storeId !== target.storeId) {
        throw new Error(
          "The trace store changed while this session was being resolved. Run `review trace allow .` again.",
        );
      }
      const mismatch = uploadManifestMismatch(manifest, begun.uploads);
      if (mismatch) throw new Error(mismatch);
      for (const upload of begun.uploads) {
        const object = compressed.find((entry) => entry.name === upload.name);
        if (!object) throw new Error(`The store offered ${upload.name} twice.`);
        await this.transport.putObject(upload, object.path);
      }

      const completed = await this.completeUploadOnce(
        input.sessionId,
        begun.uploadId,
        commits,
        labels,
      );
      this.lookups.delete(input.sessionId);
      await clearTraceSyncFailure(input.sessionId, this.devHome).catch(
        () => undefined,
      );
      return publishResult(compressed, "uploaded", target, completed, omitted);
    } finally {
      for (const object of compressed) {
        await object.cleanup();
      }
    }
  }

  /** Commits travel with the published snapshot; there is no separate index. */
  async associateCommits(_input: TraceCommitAssociation): Promise<boolean> {
    return false;
  }

  // --- helpers -------------------------------------------------------------

  private async requireSession(
    sessionId: string,
  ): Promise<TraceStoreSession | null> {
    const lookup = await this.lookupSession(sessionId);
    if (lookup.status === "unreachable") {
      throw new TraceStorageUnavailableError(
        lookup.error?.message ?? "The trace store did not answer.",
      );
    }
    // The store answered. Its answer decides; a saved copy is never served
    // as if the store had confirmed it, and a refusal is not "nothing here".
    if (lookup.status === "denied") {
      throw new TraceStorageDeniedError(lookup.error.message);
    }
    return lookup.status === "found" ? lookup.session : null;
  }

  private lookupSession(sessionId: string): Promise<StoreSessionLookup> {
    const pending = this.lookups.get(sessionId);
    if (pending) return pending;
    const lookup = this.lookupSessionLive(sessionId);
    this.lookups.set(sessionId, lookup);
    return lookup;
  }

  private async lookupSessionLive(
    sessionId: string,
  ): Promise<StoreSessionLookup> {
    if (this.offline) return { status: "unreachable", error: null };
    try {
      const response = await this.transport.listSessions(
        this.repositoryTarget.repositoryId,
        { session: sessionId },
      );
      const session = response.sessions.find(
        (candidate) => candidate.sessionId === sessionId,
      );
      return session ? { status: "found", session } : { status: "absent" };
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      this.reportFailure(cause);
      if (isStoreUnreachable(cause)) {
        return { status: "unreachable", error: cause };
      }
      if (cause instanceof StoreApiError && cause.code === "not_found") {
        return { status: "absent" };
      }
      return { status: "denied", error: cause };
    }
  }

  /**
   * Completes the upload, and once more when the first answer was lost on
   * the network: completion is idempotent, so a repeat returns the same
   * receipt. A store answer is never retried; `stale_upload` means another
   * upload of this session published first.
   */
  private async completeUploadOnce(
    sessionId: string,
    uploadId: string,
    commits: string[],
    labels: PublishLabels,
  ) {
    const complete = () =>
      this.transport.completeUpload(
        this.repositoryTarget.repositoryId,
        sessionId,
        uploadId,
        { commits, branch: labels.branch, author: labels.author },
      );
    try {
      return await complete();
    } catch (error) {
      if (error instanceof StoreApiError)
        throw syncStoreError(error, sessionId);
      try {
        return await complete();
      } catch (retryError) {
        throw retryError instanceof StoreApiError
          ? syncStoreError(retryError, sessionId)
          : retryError;
      }
    }
  }

  private reportFailure(cause: Error): void {
    const message = storeReadWarning(cause);
    if (message) this.warn(message);
  }
}

/** A session lookup, or null when the store could not be reached or refused. */
async function reachableSession<T>(
  lookup: () => Promise<T | null>,
): Promise<T | null> {
  try {
    return await lookup();
  } catch (error) {
    if (
      error instanceof TraceStorageUnavailableError ||
      error instanceof TraceStorageDeniedError
    ) {
      return null;
    }
    throw error;
  }
}

/** The checkout labels a publication carries. */
interface PublishLabels {
  branch: string | null;
  author: string | null;
}

/** Most listing pages one commit lookup walks. */
const MAX_COMMIT_LISTING_PAGES = 10;

/** Whether the manifest names exactly the stored objects, byte for byte. */
function sameObjects(
  manifest: ReadonlyArray<{ name: string; size: number; sha256: string }>,
  stored: ReadonlyArray<{ name: string; size: number; sha256: string }>,
): boolean {
  if (manifest.length !== stored.length) return false;
  return manifest.every((object) =>
    stored.some(
      (candidate) =>
        candidate.name === object.name &&
        candidate.size === object.size &&
        candidate.sha256 === object.sha256,
    ),
  );
}

function publishResult(
  compressed: ReadonlyArray<{ name: TraceObjectName; size: number }>,
  status: "uploaded" | "unchanged",
  target: TraceRepositoryTarget,
  completed: CompleteUploadResponse,
  omitted: { subagents: string[]; commits: number },
): TracePublishResult {
  return {
    uploads: compressed.map((object) => ({
      blob:
        object.name === "main.jsonl.gz"
          ? "trace.jsonl"
          : `subagents/${traceNameFromObject(object.name)}.jsonl`,
      bytes_stored: object.size,
      status,
    })),
    hosted: {
      repositoryId: target.repositoryId,
      storeId: target.storeId,
      uploadId: completed.uploadId,
      generation: completed.generation,
      complete: omitted.subagents.length === 0 && omitted.commits === 0,
      objects: completed.objects.map((object) => object.name),
      commits: completed.commits,
      omitted,
    },
  };
}

function syncStoreError(error: StoreApiError, sessionId: string): Error {
  if (error.code === "stale_upload") {
    return new Error(
      `Another upload of this session finished first. Run \`review trace sync ${sessionId}\` again to publish the newer transcript.`,
    );
  }
  return error;
}

const FIELD_SEPARATOR = "";

/** The commits whose Agent-Session trailers name this session. */
async function commitsForTraceSession(
  cwd: string,
  sessionId: string,
): Promise<string[]> {
  const result = await git(
    cwd,
    [
      "log",
      "--all",
      "--no-show-signature",
      `--format=%H${FIELD_SEPARATOR}%(trailers:key=Agent-Session,valueonly,separator=${FIELD_SEPARATOR})`,
    ],
    { allowFailure: true },
  );
  if (!result.ok) return [];
  const commits: string[] = [];
  for (const line of result.stdout.split("\n")) {
    const [sha, ...trailers] = line.trim().split(FIELD_SEPARATOR);
    if (!commitShaSchema.safeParse(sha).success) continue;
    const named = trailers
      .flatMap((value) => value.split("\n"))
      .some((value) => value.trim() === sessionId);
    if (named && !commits.includes(sha)) commits.push(sha);
  }
  return commits;
}
