import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { type BirpcReturn, type ChannelOptions, createBirpc } from "birpc";

import { errorMessage } from "../error-message";
import { findProgressiveReviewPackageRoot } from "../package-paths";
import type { ReviewPublishEvaluationInput } from "../review-publication-audit";
import type {
  DocumentWorkerApi,
  DocumentWorkerCallbacks,
  DocumentWorkerInput,
  DocumentWorkerResult,
} from "./worker-protocol";

/** The worker's transport and lifetime, separate from entry-point discovery. */
export interface DocumentWorkerTransport {
  stdout: { on(event: "data", listener: (chunk: Buffer) => void): void };
  stderr: { on(event: "data", listener: (chunk: Buffer) => void): void };
  on(event: "message", listener: Parameters<ChannelOptions["on"]>[0]): void;
  off(event: "message", listener: Parameters<ChannelOptions["on"]>[0]): void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "exit", listener: (code: number) => void): void;
  postMessage: Worker["postMessage"];
  terminate(): Promise<number>;
}

/** One worker per document. Every completion path terminates it, and late
 * callback results cannot send messages after cancellation or completion. */
export async function runDocumentWorker(
  data: DocumentWorkerInput,
  callbacks: ReviewPublishEvaluationInput,
  signal?: AbortSignal,
): Promise<DocumentWorkerResult> {
  signal?.throwIfAborted();
  const sourceMode = fileURLToPath(import.meta.url).endsWith(".ts");

  const workerPath = sourceMode
    ? new URL("./worker.ts", import.meta.url)
    : pathToFileURL(
        path.join(
          findProgressiveReviewPackageRoot(),
          "dist",
          "document",
          "worker.js",
        ),
      );

  const workerEntry = sourceMode
    ? new URL(
        `data:text/javascript,${encodeURIComponent(`import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; register(); await import(${JSON.stringify(workerPath.href)});`)}`,
      )
    : workerPath;

  const worker = new Worker(workerEntry, {
    workerData: data,
    execArgv: [],
    stdout: true,
    stderr: true,
  });

  return runDocumentWorkerWithTransport(worker, callbacks, signal);
}

export async function runDocumentWorkerWithTransport(
  worker: DocumentWorkerTransport,
  callbacks: ReviewPublishEvaluationInput,
  signal?: AbortSignal,
): Promise<DocumentWorkerResult> {
  let output = "";
  worker.stdout.on("data", (chunk) => {
    output = (output + chunk).slice(-4000);
  });
  worker.stderr.on("data", (chunk) => {
    output = (output + chunk).slice(-4000);
  });
  let finished = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  let rpc: BirpcReturn<DocumentWorkerApi, DocumentWorkerCallbacks> | undefined;

  try {
    return await new Promise<DocumentWorkerResult>((resolve, reject) => {
      let remainingMs = 30_000;
      let resumedAt = performance.now();
      let pendingCallbacks = 0;

      const resumeDeadline = () => {
        if (finished || pendingCallbacks > 0) return;
        resumedAt = performance.now();
        timeout = setTimeout(
          () => reject(new Error("Document build exceeded 30 seconds")),
          Math.max(0, remainingMs),
        );
      };

      const parentCallback = async <T>(run: () => Promise<T>): Promise<T> => {
        // Checkout preparation can be much slower than authored execution.
        // Exclude the union of parent callback waits, preserving the remaining
        // execution budget when concurrent callbacks settle independently.
        if (pendingCallbacks++ === 0) {
          clearTimeout(timeout);
          remainingMs -= performance.now() - resumedAt;
        }

        try {
          return await callbackResult(run);
        } finally {
          pendingCallbacks--;
          resumeDeadline();
        }
      };

      abort = () =>
        reject(signal?.reason ?? new Error("Document build cancelled"));
      signal?.addEventListener("abort", abort, { once: true });

      if (signal?.aborted) {
        abort();

        return;
      }

      resumeDeadline();
      worker.once("error", reject);
      worker.once("exit", (code) =>
        reject(
          new Error(
            `Document worker exited before returning (${code}): ${output}`,
          ),
        ),
      );
      rpc = createBirpc<DocumentWorkerApi, DocumentWorkerCallbacks>(
        {
          prepareEvidence: () =>
            parentCallback(() => callbacks.prepareEvidence!()),
          resolveChangedLines: (file, side) =>
            parentCallback(() => callbacks.resolveChangedLines!(file, side)),
        },
        {
          // Closing RPC removes listeners but an in-flight parent callback
          // can still finish. Never post its response to a terminated worker.
          post: (message) => {
            if (!finished) worker.postMessage(message);
          },
          on: (listener) => {
            worker.on("message", listener);
          },
          off: (listener) => {
            worker.off("message", listener);
          },
          timeout: -1,
          onGeneralError(error) {
            reject(error);

            return true;
          },
        },
      );
      void rpc.build().then(resolve, reject);
    });
  } finally {
    finished = true;
    rpc?.$close();
    clearTimeout(timeout);

    if (abort) signal?.removeEventListener("abort", abort);
    await worker.terminate();
  }
}

// Preserve the callback boundary's message-only errors, including non-Error
// rejections and errors with causes that structured cloning cannot transfer.
async function callbackResult<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new Error(errorMessage(error));
  }
}
