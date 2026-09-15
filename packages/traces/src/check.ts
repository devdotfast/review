import type {
  CliInputStream,
  StoreClient,
  TraceScope,
} from "@dev.fast/trace-core";

// Task 23 writes the body of runTracesCheck.

export interface TraceCheckResult {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface RunTracesCheckInput {
  scope: TraceScope;
  cwd: string;
  ownCliPath: string;
  runningVersion: string;
  json?: boolean;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: CliInputStream;
  client?: StoreClient;
}

/** Checks that this machine captures and publishes traces for one repository. */
export async function runTracesCheck(
  input: RunTracesCheckInput,
): Promise<number> {
  throw new Error("not implemented: runTracesCheck");
}
