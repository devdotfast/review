import { describe, expect, it } from "vitest";

import { peekResolutionOutcome } from "./peek-telemetry";

describe("peekResolutionOutcome", () => {
  it("is resolved with ranges, failed once the lenses settled without any, else pending", () => {
    expect(
      peekResolutionOutcome({
        resolvedCount: 2,
        complete: false,
        unavailable: false,
        error: false,
      }),
    ).toBe("resolved");
    expect(
      peekResolutionOutcome({
        resolvedCount: 0,
        complete: true,
        unavailable: false,
        error: false,
      }),
    ).toBe("failed");
    expect(
      peekResolutionOutcome({
        resolvedCount: 0,
        complete: false,
        unavailable: true,
        error: false,
      }),
    ).toBe("failed");
    expect(
      peekResolutionOutcome({
        resolvedCount: 0,
        complete: false,
        unavailable: false,
        error: true,
      }),
    ).toBe("failed");
    expect(
      peekResolutionOutcome({
        resolvedCount: 0,
        complete: false,
        unavailable: false,
        error: false,
      }),
    ).toBe("pending");
  });
});
