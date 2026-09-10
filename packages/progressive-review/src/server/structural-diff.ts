import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** The frontend setting opts in; the host selects the executable, never the request. */
export async function structuralDiff(input: {
  rootPath: string;
  baseRef?: string;
  headRef?: string;
  paths?: readonly string[];
  signal?: AbortSignal;
}): Promise<{ enabled: boolean; events: unknown[] }> {
  const executable = process.env.REVIEW_DIFFR_BINARY || "diffr";
  if (!input.baseRef)
    throw new Error("Structural review requires a base revision.");
  const args = ["--repo", input.rootPath, "--format", "ndjson"];
  // Match Review's merge-base-to-head comparison, including commit scopes.
  args.push(
    input.headRef ? `${input.baseRef}...${input.headRef}` : input.baseRef,
  );
  args.push("--", ...(input.paths ?? []));
  const signal = AbortSignal.any([
    AbortSignal.timeout(120_000),
    ...(input.signal ? [input.signal] : []),
  ]);
  const child = spawn(executable, args, {
    cwd: input.rootPath,
    stdio: ["ignore", "pipe", "pipe"],
    signal,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-16_384);
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "ENOENT"
        ? new Error("Cannot find diffr. Install it on the Review host PATH or set REVIEW_DIFFR_BINARY to its executable, then restart Review.")
        : error);
    });
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`diffr exited with ${code}: ${stderr}`));
    });
  });
  // Observe process errors immediately, including before stdout closes.
  void exited.catch(() => {});
  const events: unknown[] = [];
  let bytes = 0;
  let started = false;
  let completed = false;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      bytes += Buffer.byteLength(line);
      if (bytes > 64 * 1024 * 1024)
        throw new Error("Structural diff exceeded 64 MiB.");
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (completed) throw new Error("diffr emitted data after completion.");
      if (!started) {
        if (event.type !== "start" || event.version !== 1) {
          throw new Error("Unsupported diffr stream protocol.");
        }
        started = true;
      } else if (event.type === "complete") {
        completed = true;
      } else if (event.type === "file_error") {
        throw new Error(`diffr: ${event.message}`);
      } else if (event.type !== "file") {
        throw new Error(`Unexpected diffr event: ${event.type}`);
      }
      events.push(event);
    }
    await exited;
    if (!completed) throw new Error("diffr stream ended before completion.");
    return { enabled: true, events };
  } finally {
    lines.close();
    if (child.exitCode === null) child.kill();
    await exited.catch(() => {});
  }
}
