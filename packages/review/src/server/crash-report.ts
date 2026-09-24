import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { ReviewBugReportMetaV2Schema } from "@dev.fast/review-protocol";
import { z } from "zod";

import type { PostHogCaptureProperties } from "../posthog-capture-client";
import type { ReviewTelemetry } from "../review-telemetry";

const CRASH_REPORT_URL = "https://bug.dev.fast/api/v2/crashes";

const DEFAULT_MAX_DUMP_BYTES = 50 * 1024 * 1024;

const UPSTREAM_TIMEOUT_MS = 60_000;

const version = z.string().regex(/^[0-9A-Za-z.+_-]{1,64}$/);

/**
 * The envelope keys the Worker's strict crash meta accepts, with the values it
 * accepts. Any other key is dropped, and a value that would not pass is left
 * out rather than failing the whole upload.
 */
const CrashEnvelopeSchema = z.object({
  app_version: version.optional().catch(undefined),
  cli_version: version.optional().catch(undefined),
  channel: z.enum(["stable", "preview", "dev"]).optional().catch(undefined),
  environment: z
    .enum(["production", "ci", "internal", "e2e", "smoke"])
    .optional()
    .catch(undefined),
  surface: z
    .enum(["desktop", "cli", "headless", "mcp", "api"])
    .optional()
    .catch(undefined),
  platform: ReviewBugReportMetaV2Schema.shape.platform
    .optional()
    .catch(undefined),
  arch: z
    .enum([
      "arm",
      "arm64",
      "ia32",
      "loong64",
      "mips",
      "mipsel",
      "ppc",
      "ppc64",
      "riscv64",
      "s390",
      "s390x",
      "x64",
    ])
    .optional()
    .catch(undefined),
  os_version: version.optional().catch(undefined),
  node_major: z.number().int().optional().catch(undefined),
  ci: z.boolean().optional().catch(undefined),
  internal: z.boolean().optional().catch(undefined),
  app_session_id: z.uuid().optional().catch(undefined),
});

/** The body Electron main posts to `/crash-reports`. */
export const CrashReportRequestSchema = z.object({
  dump_path: z.string().min(1),
  crashed_at: z.number().int().nonnegative(),
  covered: z.boolean(),
});

export type CrashReportRequest = z.infer<typeof CrashReportRequestSchema>;

export interface CrashUploadResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * Upload one Crashpad minidump with the telemetry envelope as metadata. The
 * caller has already checked the opt-out; this only packs and posts.
 */
export async function uploadCrashDump(input: {
  dumpPath: string;
  crashedAt: number;
  covered: boolean;
  distinctId: string;
  envelope: PostHogCaptureProperties;
  fetchImpl?: typeof fetch;
  maxDumpBytes?: number;
}): Promise<CrashUploadResult> {
  const maxDumpBytes = input.maxDumpBytes ?? DEFAULT_MAX_DUMP_BYTES;

  if ((await stat(input.dumpPath)).size > maxDumpBytes)
    return { ok: false, status: 413, error: "Crash dump is too large." };

  const dump = gzipSync(await readFile(input.dumpPath), { level: 6 });

  const meta = {
    schema_version: 1,
    distinct_id: input.distinctId,
    crashed_at: input.crashedAt,
    covered: input.covered,
    dump_bytes: dump.byteLength,
    dump_sha256: createHash("sha256").update(dump).digest("hex"),
    ...CrashEnvelopeSchema.parse(input.envelope),
  };

  const form = new FormData();
  form.append("meta", JSON.stringify(meta));
  form.append(
    "dump",
    new Blob([Uint8Array.from(dump)], { type: "application/gzip" }),
    "minidump.dmp.gz",
  );

  try {
    const response = await (input.fetchImpl ?? fetch)(CRASH_REPORT_URL, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    if (!response.ok)
      return {
        ok: false,
        status: response.status,
        error: "Crash report service failed.",
      };

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error:
        error instanceof Error ? error.message : "Crash report service failed.",
    };
  }
}

/**
 * `POST /crash-reports` from Electron main. The server token also reaches the
 * canvas, so only a `.dmp` file whose real path sits inside the Review dump
 * directory is ever read. Nothing leaves the machine when telemetry is off or
 * only printed (the debug sink).
 */
export async function reportCrashDump(
  telemetry: Pick<
    ReviewTelemetry,
    "envelope" | "getInstallationId" | "sendsEvents"
  >,
  request: CrashReportRequest,
  crashDumpsDir: string | undefined,
  fetchImpl?: typeof fetch,
): Promise<{ status: number; body: CrashUploadResult & { skipped?: string } }> {
  const dumpPath = await dumpInside(request.dump_path, crashDumpsDir);

  if (!dumpPath)
    return {
      status: 403,
      body: { ok: false, error: "Not a Review crash dump." },
    };

  if (!(await telemetry.sendsEvents()))
    return { status: 200, body: { ok: true, skipped: "telemetry_disabled" } };

  const result = await uploadCrashDump({
    dumpPath,
    crashedAt: request.crashed_at,
    covered: request.covered,
    distinctId: await telemetry.getInstallationId(),
    envelope: await telemetry.envelope(),
    fetchImpl,
  });

  return { status: result.ok ? 200 : (result.status ?? 502), body: result };
}

async function dumpInside(
  file: string,
  directory: string | undefined,
): Promise<string | undefined> {
  if (!directory) return undefined;

  try {
    const [realFile, realDirectory] = await Promise.all([
      realpath(file),
      realpath(directory),
    ]);

    const relative = path.relative(realDirectory, realFile);

    if (
      !realFile.endsWith(".dmp") ||
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      return undefined;

    return realFile;
  } catch {
    return undefined;
  }
}
