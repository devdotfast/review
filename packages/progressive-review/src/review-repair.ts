import os from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";

import {
  jsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";

import { emitJsonEvent } from "./cli-output";
import { requireHealthyReviewDesktop } from "./desktop-discovery";
import { prepareReviewRepair } from "./review-repair-preparation";
import { devReviewHome } from "./review-storage";

export async function runReviewRepair(input: {
  reviewUuid?: string;
  json?: boolean;
  stdout: Writable;
  stderr: Writable;
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  try {
    if (
      !input.reviewUuid ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        input.reviewUuid,
      )
    )
      throw new Error(
        "Repair requires an explicit UUID: review repair --review <uuid>.",
      );
    const reviewDir = path.join(
      devReviewHome(input.env ?? process.env, os.homedir()),
      "reviews",
      input.reviewUuid,
    );
    const prepared = await prepareReviewRepair({
      reviewDir,
      warning: (message) => {
        emitJsonEvent(input, { event: "warning", message });
        if (!input.json) input.stderr.write(`warning: ${message}\n`);
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
      if (!input.json)
        input.stdout.write(
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
      const result = jsonObject(parseJsonText(await response.text()));
      if (!response.ok || result?.ok !== true)
        throw new Error(
          jsonString(result?.error) ??
            `Review Desktop repair failed (${response.status}).`,
        );
      emitJsonEvent(input, {
        ...result,
        event: "repaired",
        noop: false,
        sourceFallback: prepared.request.sourceFallback,
      });
      if (!input.json)
        input.stdout.write(
          `Review repaired: ${prepared.review.uuid}\nStatus preserved: ${prepared.review.status}\nDocument: ${prepared.review.presentedDocumentRevision} → ${prepared.request.newDocumentRevision}\nMap: ${prepared.review.presentedSoftwareMapRevision ?? "absent"} → ${prepared.request.newMapRevision ?? "absent"}\n`,
        );
      return 0;
    } finally {
      await prepared.cleanup();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitJsonEvent(input, { event: "error", stage: "repair", message });
    if (!input.json) input.stderr.write(`error: ${message}\n`);
    return 1;
  }
}
