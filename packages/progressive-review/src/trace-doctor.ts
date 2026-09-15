import { existsSync } from "node:fs";

import { S3TraceStorage } from "./trace-storage/s3";
import { resolveS3Setup } from "./trace-storage/s3-config";

/**
 * The bucket health check behind `review trace status` on a machine that
 * sends traces to S3/R2. Loaded on demand so the hosted path never loads
 * the AWS CLI wrapper.
 */

export interface ReviewTraceDoctorResult {
  ok: boolean;
  envPath: string;
  config?: { endpoint: string; bucket: string; accessKeyId: string };
  reachable: boolean;
  error?: string;
}

/** Reports the resolved S3 setup and bucket reachability without changing configuration. */
export async function checkReviewTraceDoctor(input?: {
  cwd?: string;
}): Promise<ReviewTraceDoctorResult> {
  void input;
  const setup = resolveS3Setup();
  // The path reported is the source the credentials came from: the
  // version-2 profile when it supplies them, otherwise the legacy env file.
  const envPath = setup.source === "profile" ? setup.configPath : setup.envPath;

  if (process.env.TRACE_R2_MODE === "mock") {
    return {
      ok: true,
      envPath,
      config: {
        endpoint: "mock://endpoint",
        bucket: "mock-bucket",
        accessKeyId: "mock-key",
      },
      reachable: true,
    };
  }

  const config = setup.credentials;

  if (!config) {
    const anyInput =
      setup.profile !== null ||
      existsSync(setup.envPath) ||
      Boolean(process.env.TRACE_R2_BUCKET);

    return {
      ok: false,
      envPath,
      reachable: false,
      error: anyInput
        ? "Configuration is missing one or more required S3/R2 values."
        : "No trace configuration found. Use Review Agent Setup to configure trace capture.",
    };
  }

  const summary = {
    endpoint: config.endpoint,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
  };

  const doctor = await S3TraceStorage.fromCredentials(config).doctor();

  if (doctor.reachable) {
    return { ok: true, envPath, config: summary, reachable: true };
  }

  return {
    ok: false,
    envPath,
    config: summary,
    reachable: false,
    error: doctor.error,
  };
}
