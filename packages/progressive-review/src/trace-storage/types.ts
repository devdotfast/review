import type { SessionMeta } from "@dev.fast/review-protocol";

/**
 * The operation-level boundary between Review's shared trace code and one
 * remote trace store. Shared callers see sessions, trace names, and commits;
 * a backend owns its object layout, transport, and completion semantics.
 */

export type TraceStorageKind = "s3" | "hosted";

/** One S3-compatible bucket, identified without its secret. */
export interface S3StorageTarget {
  kind: "s3";
  endpoint: string;
  bucket: string;
  region: string;
  /** Present when the bucket is a test double under TRACE_R2_MODE=mock. */
  mockRoot?: string;
}

/** One repository store on one hosted origin. */
export interface HostedStorageTarget {
  kind: "hosted";
  origin: string;
  repositoryId: number;
  storeId: string;
  name: string;
}

export type TraceStorageTarget = S3StorageTarget | HostedStorageTarget;

export interface TraceObjectInfo {
  size: number;
  /**
   * What the backend can verify about the object's content. Direct storage
   * only knows sizes; hosted storage knows checksums and generations.
   */
  contentId: string;
}

export interface TraceCommitSessions {
  sessions: string[];
  pr: number | null;
  branch: string | null;
}

export interface TracePublishFile {
  /** "main" for the primary transcript, otherwise the subagent file name. */
  name: string;
  path: string;
}

export interface TracePublishInput {
  sessionId: string;
  cwd: string;
  repo: { owner: string; repo: string };
  /** Which harness produced the transcript. */
  harness: "claude" | "codex" | "opencode" | "pi";
  files: TracePublishFile[];
  /** Commits to associate. Undefined lets the backend discover them. */
  commits?: string[];
  branch: string | null;
  author: string | null;
}

export interface TracePublishUpload {
  blob: string;
  bytes_stored: number;
  status: "uploaded" | "unchanged";
}

/** Hosted publication details, additive to the direct result shape. */
export interface HostedPublishDetails {
  repositoryId: number;
  storeId: string;
  uploadId: string;
  generation: number;
  complete: boolean;
  objects: string[];
  commits: string[];
  omitted: { subagents: string[]; commits: number };
}

export interface TracePublishResult {
  uploads: TracePublishUpload[];
  hosted?: HostedPublishDetails;
}

/** The store did not answer; a saved copy may be served, labeled offline. */
export class TraceStorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceStorageUnavailableError";
  }
}

export interface TraceStorageReadiness {
  /** The backend can be asked for sessions and objects right now. */
  ready: boolean;
  /** A short, secret-free reason when not ready. */
  reason?: string;
}

export interface TraceStorage {
  readonly kind: TraceStorageKind;
  readonly target: TraceStorageTarget;
  /** Scopes cache paths and freshness checks so two stores never share one. */
  cacheIdentity(): string;
  /**
   * The corpus directory pair for one repository's traces. Direct storage
   * keeps `<owner>/<repo>`; hosted storage keys by origin and repository id.
   * Null when the backend cannot place the cache without a repository.
   */
  cacheScope(
    repo: { owner: string; repo: string } | null,
  ): { owner: string; repo: string } | null;
  readiness(): Promise<TraceStorageReadiness>;
  describeObject(
    sessionId: string,
    traceName: string,
  ): Promise<TraceObjectInfo | null>;
  downloadObject(
    sessionId: string,
    traceName: string,
    destinationPath: string,
  ): Promise<TraceObjectInfo | null>;
  listSubagents(sessionId: string): Promise<string[]>;
  sessionMeta(sessionId: string): Promise<SessionMeta | null>;
  sessionsForCommit(commit: string): Promise<TraceCommitSessions | null>;
  publish(input: TracePublishInput): Promise<TracePublishResult>;
  /**
   * Records which sessions produced a commit. Direct storage writes a
   * by-commit index entry once; hosted storage records commits with the
   * published snapshot and returns false here.
   */
  associateCommits(input: TraceCommitAssociation): Promise<boolean>;
}

export interface TraceCommitAssociation {
  commit: string;
  sessions: string[];
  branch: string | null;
  /** Repository and pull-request details, read only when an entry is written. */
  resolve: () => Promise<{
    repo: { owner: string; repo: string };
    pr: number | null;
  }>;
}
