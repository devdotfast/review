import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  REVIEW_CHANNEL_ENV,
  REVIEW_TELEMETRY_ENV_ENV,
  createTelemetryInstallConfig,
  normalizeTelemetryInstallConfig,
  reviewTelemetryChannel,
  reviewTelemetryConfigPath,
  reviewTelemetryEnvironment,
} from "./telemetry-config";

describe("reviewTelemetryChannel", () => {
  it.each([
    [{}, "stable"],
    [{ [REVIEW_CHANNEL_ENV]: "preview" }, "preview"],
    [{ [REVIEW_CHANNEL_ENV]: "dev" }, "dev"],
    [{ [REVIEW_CHANNEL_ENV]: "nightly" }, "stable"],
  ])("reads %j as %s", (env, expected) => {
    expect(reviewTelemetryChannel(env)).toBe(expected);
  });
});

describe("reviewTelemetryEnvironment", () => {
  const home = { DEV_REVIEW_HOME: "/tmp/x" };

  it("prefers the explicit test-harness value over CI and internal", () => {
    expect(
      reviewTelemetryEnvironment(
        { ...home, [REVIEW_TELEMETRY_ENV_ENV]: "e2e", CI: "1" },
        { internal: true },
      ),
    ).toBe("e2e");
    expect(
      reviewTelemetryEnvironment({ ...home, [REVIEW_TELEMETRY_ENV_ENV]: "smoke" }),
    ).toBe("smoke");
  });

  it("ignores an unknown harness value", () => {
    expect(
      reviewTelemetryEnvironment({
        ...home,
        [REVIEW_TELEMETRY_ENV_ENV]: "staging",
        PROGRESSIVE_REVIEW_TELEMETRY_INTERNAL: "0",
      }),
    ).toBe("production");
  });

  it("ranks ci above internal above production", () => {
    expect(reviewTelemetryEnvironment({ ...home, CI: "true" }, { internal: true })).toBe("ci");
    expect(
      reviewTelemetryEnvironment(
        { ...home, PROGRESSIVE_REVIEW_TELEMETRY_INTERNAL: "1" },
        { internal: false },
      ),
    ).toBe("internal");
    expect(
      reviewTelemetryEnvironment(
        { ...home, PROGRESSIVE_REVIEW_TELEMETRY_INTERNAL: "0" },
        { internal: true },
      ),
    ).toBe("production");
  });
});

describe("reviewTelemetryConfigPath", () => {
  it("keeps the stable file and gives preview its own", () => {
    const env = { DEV_REVIEW_HOME: "/tmp/review-home" };

    expect(reviewTelemetryConfigPath(env)).toBe(
      path.join("/tmp/review-home", "telemetry", "progressive-review.json"),
    );
    expect(
      reviewTelemetryConfigPath({ ...env, [REVIEW_CHANNEL_ENV]: "preview" }),
    ).toBe(
      path.join("/tmp/review-home", "telemetry", "progressive-review.preview.json"),
    );
  });
});

describe("install config", () => {
  it("defaults firstReviewPresentedSent to false and normalizes a stored true", () => {
    const now = () => new Date("2026-01-02T03:04:05.000Z");

    expect(createTelemetryInstallConfig("id", now).firstReviewPresentedSent).toBe(false);
    expect(
      normalizeTelemetryInstallConfig(
        { installationId: "id", firstReviewPresentedSent: true },
        now,
      )?.firstReviewPresentedSent,
    ).toBe(true);
    expect(
      normalizeTelemetryInstallConfig(
        { installationId: "id", firstReviewPresentedSent: "yes" },
        now,
      )?.firstReviewPresentedSent,
    ).toBe(false);
  });
});
