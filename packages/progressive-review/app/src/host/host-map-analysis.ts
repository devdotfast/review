import {
  type HostDocumentState,
  HostIdSchema,
  HostOidSchema,
  type HostReviewVersionHeader,
  type JsonValue,
  type ReviewClient,
} from "@dev.fast/review-protocol";
import { z } from "zod";

import type { SoftwareMapDiffCountsResult } from "../../../src/software-map-diff-counts";
import type { SoftwareMapDiffCounts } from "../software-map/software-map-snapshot";

const savedMapRequest = z.object({
  savedMap: z.strictObject({ id: HostIdSchema, commit: HostOidSchema }),
});

/** Adapt saved-resource analysis to the existing map views. Labels, source
 * coverage and hierarchy remain host-owned; none are resent as query input. */
export async function resolveHostSoftwareMapData(
  client: Pick<ReviewClient, "query">,
  state: { document: HostDocumentState; snapshot: HostReviewVersionHeader },
  body: JsonValue,
  signal?: AbortSignal,
): Promise<SoftwareMapDiffCountsResult & { ok: true }> {
  const { savedMap } = savedMapRequest.parse(body);
  const { binding, mapVersions: selected } = state.snapshot;
  const mapVersions =
    savedMap.id === selected.base || savedMap.id === selected.head
      ? selected
      : savedMap.commit === binding.headCommit
        ? { base: null, head: savedMap.id }
        : savedMap.commit === binding.baseCommit
          ? { base: savedMap.id, head: null }
          : null;
  if (mapVersions === null)
    throw new Error(
      "This saved map does not match the displayed review's source revisions.",
    );
  const countsByElementPath: Record<string, SoftwareMapDiffCounts> = {};
  const unmappedByElementPath: SoftwareMapDiffCountsResult["unmappedByElementPath"] =
    {};
  let cursor: string | undefined;
  do {
    const { result } = await client.query(
      "map.analyze",
      {
        reviewId: state.document.reviewId,
        reviewVersion: state.document.reviewVersion,
        mapVersions,
        includeDiff: true,
        limit: 200,
        cursor,
      },
      signal,
    );
    for (const item of result.items) {
      const counts = {
        additions: item.additions,
        deletions: item.deletions,
        changeStatus: item.changeStatus,
      };
      countsByElementPath[item.elementId] = counts;
      // The old view calls its detailed source bucket "unmapped". New host
      // counts already include the complete descendant scope and are exact.
      unmappedByElementPath[item.elementId] = {
        ...counts,
        files: (item.diff?.files ?? []).map((file) => ({
          file: file.headFile ?? file.baseFile!,
          additions: file.hunks.reduce(
            (total, hunk) =>
              total + hunk.lines.filter((line) => line.kind === "add").length,
            0,
          ),
          deletions: file.hunks.reduce(
            (total, hunk) =>
              total +
              hunk.lines.filter((line) => line.kind === "remove").length,
            0,
          ),
          hunks: file.hunks.map((hunk) => ({
            startLine: Math.max(
              1,
              hunk.headRange.lineCount
                ? hunk.headRange.startLine
                : hunk.baseRange.startLine,
            ),
            lines: hunk.lines.map((line) => ({
              kind: line.kind,
              oldLine: line.baseLine,
              newLine: line.headLine,
              text: line.text,
            })),
          })),
        })),
      };
    }
    cursor = result.nextCursor ?? undefined;
  } while (cursor);
  return {
    ok: true,
    baseRef: binding.baseCommit,
    headRef: binding.headCommit,
    countsByElementPath,
    unmappedByElementPath,
  };
}
