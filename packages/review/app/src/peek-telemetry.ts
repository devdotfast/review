export type PeekResolutionOutcome = "resolved" | "failed" | "pending";

/** Mirrors CodePeekCard's placeholder logic so telemetry and UI agree. */
export function peekResolutionOutcome(input: {
  resolvedCount: number;
  complete: boolean;
  unavailable: boolean;
  error: boolean;
}): PeekResolutionOutcome {
  if (input.resolvedCount > 0) return "resolved";

  return input.complete || input.unavailable || input.error
    ? "failed"
    : "pending";
}
