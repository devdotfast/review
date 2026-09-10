import { isMainThread, parentPort, workerData } from "node:worker_threads";

import { createBirpc } from "birpc";

import { evaluateReviewDocumentForPublish } from "../review-publication-audit";
import type { ReviewDocumentDiagnostic } from "./diagnostics";
import { loadDocumentModule } from "./module-loader";
import type {
  DocumentWorkerApi,
  DocumentWorkerCallbacks,
  DocumentWorkerInput,
  DocumentWorkerResult,
} from "./worker-protocol";

// The parent runs one build and terminates this worker on every exit path.
// Authored module caches, globals and hooks never survive a publication.
if (isMainThread || !parentPort)
  throw new Error("Document construction requires a disposable worker.");
const input: DocumentWorkerInput = workerData;
const port = parentPort;
const rpc = createBirpc<DocumentWorkerCallbacks, DocumentWorkerApi>(
  {
    async build(): Promise<DocumentWorkerResult> {
      const diagnostics: ReviewDocumentDiagnostic[] = [];
      const result = await evaluateReviewDocumentForPublish(
        {
          ranges: input.ranges,
          prepareEvidence: input.hasEvidence ? rpc.prepareEvidence : undefined,
          resolveChangedLines: input.hasChangedLines
            ? rpc.resolveChangedLines
            : undefined,
        },
        (runtime) => loadDocumentModule(input, runtime, diagnostics),
      );
      return { result, diagnostics };
    },
  },
  {
    post: (message) => port.postMessage(message),
    on: (listener) => {
      port.on("message", listener);
    },
    off: (listener) => {
      port.off("message", listener);
    },
    // The parent owns the execution deadline and pauses it for evidence callbacks.
    timeout: -1,
  },
);
