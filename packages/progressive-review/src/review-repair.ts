import os from "node:os";
import type { Writable } from "node:stream";

import {
  jsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";

import { emitJsonEvent, failWithJsonError, humanStream } from "./cli-output";
import { requireHealthyReviewDesktop } from "./desktop-discovery";
import { UUID_PATTERN, findScopedReview } from "./review-home";
import { prepareReviewRepair } from "./review-repair-preparation";
import { ReviewRepairReadyResponseSchema } from "./review-repair-state";
import { devReviewHome } from "./review-storage";
import { resolveReviewRoot } from "./runtime";

export async function runReviewRepair(input: {
  cwd: string;
  reviewUuid?: string;
  json?: boolean;
  stdout: Writable;
  stderr: Writable;
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  try {
    if (!input.reviewUuid || !UUID_PATTERN.test(input.reviewUuid))
      throw new Error(
        "Repair requires an explicit UUID: review repair --review <uuid>.",
      );
    const review = await findScopedReview(input.reviewUuid, {
      worktreePath: await resolveReviewRoot(input.cwd),
      includeTerminal: true,
      includeLegacySchema: true,
      devHome: devReviewHome(input.env ?? process.env, os.homedir()),
    });
    if (!review)
      throw new Error(`Review not found in this checkout: ${input.reviewUuid}`);
    const prepared = await prepareReviewRepair({
      reviewDir: review.dir,
      warning: (message) => {
        emitJsonEvent(input, { event: "warning", message });
        input.stderr.write(`warning: ${message}\n`);
      },
    });
    if (prepared.kind === "noop") {
      emitJsonEvent(input, {
        event: "repaired",
        noop: true,
        reviewUuid: prepared.review.uuid,
        status: prepared.review.status,
        oldDocumentRevision: prepared.review.presentedDocumentRevision,
        oldMapRevision: prepared.review.presentedSoftwareMapRevision,
        newDocumentRevision: prepared.review.presentedDocumentRevision,
        newMapRevision: prepared.review.presentedSoftwareMapRevision,
      });
      humanStream(input).write(
        "Current Review artifacts are healthy; no repair needed.\n",
      );
      return 0;
    }
    try {
      const discovery = await requireHealthyReviewDesktop("review repair");
      const response = await fetch(`${discovery.url}/repair-ready`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-review-token": discovery.token,
        },
        body: JSON.stringify(prepared.request),
      });
      const body = jsonObject(parseJsonText(await response.text()));
      const parsed = ReviewRepairReadyResponseSchema.safeParse(body);
      if (!response.ok || !parsed.success)
        throw new Error(
          jsonString(body?.error) ??
            `Review Desktop repair failed (${response.status}).`,
        );
      emitJsonEvent(input, {
        ...parsed.data,
        event: "repaired",
        noop: false,
        sourceFallback: prepared.request.sourceFallback,
      });
      humanStream(input).write(
        `Review repaired: ${prepared.review.uuid}\nStatus preserved: ${prepared.review.status}\nDocument: ${prepared.review.presentedDocumentRevision} → ${prepared.request.newDocumentRevision}\nMap: ${prepared.review.presentedSoftwareMapRevision ?? "absent"} → ${prepared.request.newMapRevision ?? "absent"}\n`,
      );
      return 0;
    } finally {
      await prepared.cleanup();
    }
  } catch (error) {
    return failWithJsonError(
      input,
      "repair",
      error instanceof Error ? error.message : String(error),
    );
  }
}
