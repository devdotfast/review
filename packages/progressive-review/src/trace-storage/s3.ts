import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  type ByCommitEntry,
  type JsonValue,
  type SessionMeta,
  byCommitSchema,
  commitShaSchema,
  jsonArray,
  jsonNumber,
  jsonObject,
  jsonString,
  parseJsonText,
  sessionMetaSchema,
} from "@dev.fast/review-protocol";

import {
  type S3ConfigScope,
  type S3Credentials,
  isS3MockMode,
  resolveS3Credentials,
  s3MockRoot,
} from "./s3-config";
import type {
  S3StorageTarget,
  TraceCommitAssociation,
  TraceCommitSessions,
  TraceObjectInfo,
  TracePublishInput,
  TracePublishResult,
  TracePublishUpload,
  TraceStorage,
  TraceStorageReadiness,
} from "./types";

/**
 * Direct S3/R2 storage through the AWS CLI. Owns the legacy bucket layout:
 *
 *   by-session/<session>/trace.jsonl
 *   by-session/<session>/subagents/<name>.jsonl
 *   by-session/<session>/meta.json
 *   by-commit/<sha>.json
 *
 * Objects only grow: a transcript is re-uploaded when the local copy is
 * larger than the stored one, and a by-commit entry is written once.
 */

const execFileAsync = promisify(execFile);

export interface S3DoctorResult {
  reachable: boolean;
  error?: string;
}

export class S3TraceStorage implements TraceStorage {
  readonly kind = "s3" as const;
  readonly target: S3StorageTarget;

  private constructor(
    private readonly config: S3Credentials | null,
    private readonly mockRoot: string | null,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    this.target = config
      ? {
          kind: "s3",
          endpoint: config.endpoint,
          bucket: config.bucket,
          region: config.region,
        }
      : {
          kind: "s3",
          endpoint: "mock://endpoint",
          bucket: "mock-bucket",
          region: "auto",
          mockRoot: mockRoot ?? undefined,
        };
  }

  /**
   * The bucket named by the legacy configuration, or null when none is
   * configured. Mock mode yields a storage backed by a directory.
   */
  static fromEnvironment(scope: S3ConfigScope = {}): S3TraceStorage | null {
    const env = scope.env ?? process.env;
    if (isS3MockMode(env)) {
      return new S3TraceStorage(null, s3MockRoot(env), env);
    }
    const config = resolveS3Credentials(scope);
    return config ? new S3TraceStorage(config, null, env) : null;
  }

  static fromCredentials(
    config: S3Credentials,
    env: NodeJS.ProcessEnv = process.env,
  ): S3TraceStorage {
    return new S3TraceStorage(config, null, env);
  }

  /** Secret-free identity of the destination; the same bucket keys the same cache. */
  cacheIdentity(): string {
    if (!this.config) return `s3:mock:${this.mockRoot ?? ""}`;
    const digest = createHash("sha256")
      .update(
        `${normalizeEndpoint(this.config.endpoint)}\n${this.config.bucket}`,
      )
      .digest("hex")
      .slice(0, 16);
    return `s3:${digest}`;
  }

  cacheScope(
    repo: { owner: string; repo: string } | null,
  ): { owner: string; repo: string } | null {
    return repo;
  }

  async readiness(): Promise<TraceStorageReadiness> {
    return { ready: true };
  }

  async describeObject(
    sessionId: string,
    traceName: string,
  ): Promise<TraceObjectInfo | null> {
    const size = await this.headObjectSize(objectKey(sessionId, traceName));
    return size === null ? null : { size, contentId: `size:${size}` };
  }

  async downloadObject(
    sessionId: string,
    traceName: string,
    destinationPath: string,
  ): Promise<TraceObjectInfo | null> {
    if (
      !(await this.getObject(objectKey(sessionId, traceName), destinationPath))
    ) {
      return null;
    }
    const size = statSync(destinationPath).size;
    return { size, contentId: `size:${size}` };
  }

  async listSubagents(sessionId: string): Promise<string[]> {
    const prefix = `by-session/${sessionId}/subagents/`;
    const names = new Set<string>();
    if (this.mockRoot !== null || !this.config) {
      if (this.mockRoot) {
        const dir = path.join(this.mockRoot, prefix);
        if (existsSync(dir)) {
          try {
            for (const entry of readdirSync(dir)) {
              if (entry.endsWith(".jsonl")) names.add(entry.slice(0, -6));
            }
          } catch {
            // Ignore mock readdir errors
          }
        }
      }
      return [...names].sort();
    }
    try {
      const proc = await this.aws(
        [
          "s3api",
          "list-objects-v2",
          "--bucket",
          this.config.bucket,
          "--prefix",
          prefix,
        ],
        { timeout: 10_000 },
      );
      const listing = jsonObject(parseJsonText(proc.stdout));
      for (const item of jsonArray(listing?.Contents) ?? []) {
        const key = jsonString(jsonObject(item)?.Key);
        if (key && key.startsWith(prefix) && key.endsWith(".jsonl")) {
          const name = key.slice(prefix.length, -6);
          if (name) names.add(name);
        }
      }
    } catch {
      // Ignore remote list failure
    }
    return [...names].sort();
  }

  async sessionMeta(sessionId: string): Promise<SessionMeta | null> {
    try {
      const parsed = sessionMetaSchema.safeParse(
        await this.getJson(metaKey(sessionId)),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async sessionsForCommit(commit: string): Promise<TraceCommitSessions | null> {
    if (!commitShaSchema.safeParse(commit).success) return null;
    try {
      const parsed = byCommitSchema.safeParse(
        await this.getJson(commitKey(commit)),
      );
      if (!parsed.success || parsed.data.sessions.length === 0) return null;
      return {
        sessions: parsed.data.sessions,
        pr: parsed.data.pr,
        branch: parsed.data.branch,
      };
    } catch {
      return null;
    }
  }

  async publish(input: TracePublishInput): Promise<TracePublishResult> {
    const uploads: TracePublishUpload[] = [];
    for (const file of input.files) {
      const key = objectKey(input.sessionId, file.name);
      const grown = await this.putIfGrown(key, file.path);
      uploads.push({
        blob: file.name === "main" ? "trace.jsonl" : `subagents/${file.name}`,
        bytes_stored: statSync(file.path).size,
        status: grown ? "uploaded" : "unchanged",
      });
    }

    // Session metadata is read, merged, and written back.
    const existing = await this.sessionMeta(input.sessionId);
    const meta: SessionMeta = {
      session: input.sessionId,
      repo: `${input.repo.owner}/${input.repo.repo}`,
      branch: input.branch ?? existing?.branch ?? null,
      pr: existing?.pr ?? null,
      commits: deduplicateStrings([
        ...(existing?.commits ?? []),
        ...(input.commits ?? []).filter(
          (commit) => commitShaSchema.safeParse(commit).success,
        ),
      ]),
      author: input.author ?? existing?.author ?? null,
      ts: new Date().toISOString(),
    };
    const saved = await this.putBuffer(
      metaKey(input.sessionId),
      Buffer.from(JSON.stringify(meta, null, 2), "utf8"),
    );
    if (!saved) {
      throw new Error(
        `Failed to update session metadata for ${input.sessionId} in S3/R2 storage.`,
      );
    }
    return { uploads };
  }

  async associateCommits(input: TraceCommitAssociation): Promise<boolean> {
    const commit = commitShaSchema.parse(input.commit);
    const existing = await this.getJson(commitKey(commit));
    if (existing !== null) return false;
    const { repo, pr } = await input.resolve();
    const entry: ByCommitEntry = byCommitSchema.parse({
      commit,
      sessions: deduplicateStrings(input.sessions),
      repo: `${repo.owner}/${repo.repo}`,
      pr,
      branch: input.branch,
      indexed_by: "hook",
      ts: new Date().toISOString(),
    });
    const saved = await this.putBuffer(
      commitKey(commit),
      Buffer.from(JSON.stringify(entry, null, 2), "utf8"),
    );
    if (!saved) {
      throw new Error(`Failed to write by-commit/${commit}.json.`);
    }
    return true;
  }

  /** A non-mutating reachability check of the configured bucket. */
  async doctor(): Promise<S3DoctorResult> {
    if (!this.config) return { reachable: true };
    try {
      await this.aws(["s3api", "head-bucket", "--bucket", this.config.bucket], {
        timeout: 15_000,
      });
      return { reachable: true };
    } catch (error) {
      return {
        reachable: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // --- transport -----------------------------------------------------------

  private async headObjectSize(key: string): Promise<number | null> {
    if (!this.config) {
      if (!this.mockRoot) return null;
      try {
        const stats = statSync(path.join(this.mockRoot, key));
        return stats.isFile() ? stats.size : null;
      } catch {
        return null;
      }
    }
    try {
      const proc = await this.aws(
        ["s3api", "head-object", "--bucket", this.config.bucket, "--key", key],
        { timeout: 10_000 },
      );
      return (
        jsonNumber(jsonObject(parseJsonText(proc.stdout))?.ContentLength) ??
        null
      );
    } catch {
      return null;
    }
  }

  private async getObject(key: string, destPath: string): Promise<boolean> {
    mkdirSync(path.dirname(destPath), { recursive: true });
    if (!this.config) {
      if (!this.mockRoot) return false;
      try {
        writeFileSync(destPath, readFileSync(path.join(this.mockRoot, key)));
        return true;
      } catch {
        return false;
      }
    }
    try {
      await this.aws(
        [
          "s3api",
          "get-object",
          "--bucket",
          this.config.bucket,
          "--key",
          key,
          destPath,
        ],
        { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      );
      return existsSync(destPath);
    } catch {
      return false;
    }
  }

  private async getJson(key: string): Promise<JsonValue | null> {
    const tmpPath = path.join(
      tmpdir(),
      `r2-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    );
    try {
      if (!(await this.getObject(key, tmpPath))) return null;
      return parseJsonText(readFileSync(tmpPath, "utf8"));
    } catch {
      return null;
    } finally {
      rmSync(tmpPath, { force: true });
    }
  }

  private async putFile(key: string, filePath: string): Promise<boolean> {
    if (!this.config) {
      if (!this.mockRoot) return false;
      try {
        const target = path.join(this.mockRoot, key);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(filePath));
        return true;
      } catch {
        return false;
      }
    }
    try {
      await this.aws(
        [
          "s3",
          "cp",
          "--only-show-errors",
          filePath,
          `s3://${this.config.bucket}/${key}`,
        ],
        { timeout: 60_000 },
      );
      return true;
    } catch {
      return false;
    }
  }

  private async putBuffer(key: string, content: Buffer): Promise<boolean> {
    if (!this.config) {
      if (!this.mockRoot) return false;
      try {
        const target = path.join(this.mockRoot, key);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);
        return true;
      } catch {
        return false;
      }
    }
    const tempFile = path.join(
      tmpdir(),
      `put-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`,
    );
    writeFileSync(tempFile, content);
    try {
      return await this.putFile(key, tempFile);
    } finally {
      rmSync(tempFile, { force: true });
    }
  }

  private async putIfGrown(key: string, filePath: string): Promise<boolean> {
    const remoteSize = await this.headObjectSize(key);
    const localSize = statSync(filePath).size;
    if (remoteSize !== null && localSize <= remoteSize) return false;
    if (!(await this.putFile(key, filePath))) {
      throw new Error(`Failed to upload ${key} to S3/R2 storage.`);
    }
    return true;
  }

  private aws(
    args: string[],
    options: { timeout: number; maxBuffer?: number },
  ): Promise<{ stdout: string; stderr: string }> {
    const config = this.config;
    if (!config) throw new Error("S3 trace storage is not configured.");
    return execFileAsync(
      "aws",
      ["--region", config.region, "--endpoint-url", config.endpoint, ...args],
      {
        ...options,
        env: {
          ...this.env,
          AWS_ACCESS_KEY_ID: config.accessKeyId,
          AWS_SECRET_ACCESS_KEY: config.secretAccessKey,
        },
      },
    );
  }
}

function objectKey(sessionId: string, traceName: string): string {
  return traceName === "main"
    ? `by-session/${sessionId}/trace.jsonl`
    : `by-session/${sessionId}/subagents/${normalizeSubagentFileName(traceName)}`;
}

function metaKey(sessionId: string): string {
  return `by-session/${sessionId}/meta.json`;
}

function commitKey(commit: string): string {
  return `by-commit/${commit}.json`;
}

export function normalizeSubagentFileName(name: string): string {
  const base = path.basename(name);
  return base.endsWith(".jsonl") ? base : `${base}.jsonl`;
}

function normalizeEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/+$/, "").toLowerCase();
  } catch {
    return endpoint.trim().replace(/\/+$/, "").toLowerCase();
  }
}

function deduplicateStrings(items: string[]): string[] {
  return [...new Set(items)];
}
