import type { ReviewSession } from "../host/review-session";

export async function refreshSoftwareMapArtifacts(
  session: ReviewSession,
): Promise<void> {
  const reviewFetch = session.fetch;
  const response = await reviewFetch("/software-map/artifacts/refresh", {
    method: "POST",
  });
  const json = (await response.json()) as
    | { ok: true; refresh: { status: "rematerialized" | "skipped" } }
    | { ok: false; error?: string };
  if (!response.ok || !json.ok) {
    throw new Error(
      json.ok
        ? "SoftwareMap artifact refresh failed"
        : (json.error ?? "SoftwareMap artifact refresh failed"),
    );
  }
}
