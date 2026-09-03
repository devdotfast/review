import type { JsonObject } from "@dev.fast/review-protocol";
import { createContext, useContext } from "react";

/**
 * Initial review data gathered by the route loader during SSR (and on
 * client-side navigations). Payloads are the raw middleware JSON bodies —
 * consumers own their parsing, exactly as they do for their own fetches.
 * A null field means the loader could not produce that payload; the owning
 * consumer then performs its usual client fetch.
 *
 * This module is import-cycle-neutral on purpose: the loader imports helpers
 * from SoftwareMap, and SoftwareMap imports this context, so neither may
 * import the other through this file.
 */
export interface SoftwareMapInitialResolvedData {
  key: string;
  response: unknown;
}

export interface ReviewInitialData {
  comments: JsonObject | null;
  sessionResolvedBaseRef: string | null;
  documentMeta: {
    updatedAtMs?: number;
    pullRequestNumber?: number;
    pullRequestUrl?: string;
  } | null;
  diffStats: {
    files?: { additions?: number; deletions?: number }[];
  } | null;
  softwareMapResolvedData: SoftwareMapInitialResolvedData[];
}

export const ReviewInitialDataContext = createContext<ReviewInitialData | null>(
  null,
);

export function useReviewInitialData(): ReviewInitialData | null {
  return useContext(ReviewInitialDataContext);
}
