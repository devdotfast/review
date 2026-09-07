import type { Writable } from "node:stream";

import { emitJsonEvent, failWithJsonError, humanStream } from "./cli-output";
import { requestReviewLifecycle } from "./review-lifecycle-client";
import { ReviewRepairResultSchema } from "./review-lifecycle-contracts";

export async function runReviewRepair(input: {
  cwd: string;
  reviewUuid?: string;
  json?: boolean;
  stdout: Writable;
  stderr: Writable;
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  try {
    if (!input.reviewUuid)
      throw new Error(
        "Review repair requires an explicit UUID (--review <uuid>).",
      );
    const result = ReviewRepairResultSchema.parse(
      await requestReviewLifecycle("/lifecycle/repair", {
        cwd: input.cwd,
        reviewUuid: input.reviewUuid,
      }),
    );
    for (const message of result.warnings) {
      emitJsonEvent(input, { event: "warning", message });
      input.stderr.write(`warning: ${message}\n`);
    }
    emitJsonEvent(input, { ...result, event: "repaired" });
    humanStream(input).write(
      result.noop
        ? "Current Review artifacts are healthy; no repair needed.\n"
        : `Review repaired: ${result.reviewUuid}\nStatus preserved: ${result.status}\nDocument: ${result.oldDocumentRevision} → ${result.newDocumentRevision}\nMap: ${result.oldMapRevision ?? "absent"} → ${result.newMapRevision ?? "absent"}\n`,
    );
    return 0;
  } catch (error) {
    return failWithJsonError(
      input,
      "repair",
      error instanceof Error ? error.message : String(error),
    );
  }
}
