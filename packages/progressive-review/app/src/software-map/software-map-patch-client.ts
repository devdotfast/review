import {
  isJsonObject,
  jsonBoolean,
  jsonProperty,
  jsonString,
} from "@dev.fast/review-protocol";

import type { ReviewSession } from "../host/review-session";

export async function refreshSoftwareMapArtifacts(
  session: ReviewSession,
): Promise<void> {
  const reviewFetch = session.fetch;
  const response = await reviewFetch("/software-map/artifacts/refresh", {
    method: "POST",
  });
  const json: unknown = await response.json();
  const body = isJsonObject(json) ? json : null;
  const ok = body ? jsonBoolean(jsonProperty(body, "ok")) === true : false;
  if (!response.ok || !ok) {
    const error = body ? jsonString(jsonProperty(body, "error")) : undefined;
    throw new Error(
      ok
        ? "SoftwareMap artifact refresh failed"
        : (error ?? "SoftwareMap artifact refresh failed"),
    );
  }
}
