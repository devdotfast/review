import type { ReviewCliInstallStatus } from "@dev.fast/review-protocol";
import { describe, expect, it } from "vitest";

import { preferredInstalledReviewAgent } from "./installed-review-agent";

function status(
  targets: NonNullable<ReviewCliInstallStatus["stamp"]>["targets"],
  installed: ReviewCliInstallStatus["agents"][number]["target"][],
): ReviewCliInstallStatus {
  return {
    agents: ["claude", "codex", "cursor", "pi"].map((target) => ({
      target: target as ReviewCliInstallStatus["agents"][number]["target"],
      present: true,
      installed: installed.includes(
        target as ReviewCliInstallStatus["agents"][number]["target"],
      ),
    })),
    fingerprint: "fingerprint",
    stamp: {
      consent: "granted",
      targets,
      updatedAt: "2026-08-25T00:00:00.000Z",
    },
    stale: false,
    shim: {
      path: "/tmp/review",
      installed: true,
      profileConfigured: true,
      onPath: true,
    },
    fff: {
      serverName: "fff",
      corpusRoot: "/tmp/fff",
      binary: { path: "/tmp/fff-bin", installed: true },
      registrations: [],
    },
    trace: { enabled: false },
    cli: null,
  };
}

describe("preferredInstalledReviewAgent", () => {
  it("preserves the agent order chosen during onboarding", () => {
    expect(
      preferredInstalledReviewAgent(
        status(["pi", "codex", "claude"], ["claude", "codex", "pi"]),
      ),
    ).toBe("pi");
  });

  it("skips selected agents that are no longer installed", () => {
    expect(
      preferredInstalledReviewAgent(status(["claude", "codex"], ["codex"])),
    ).toBe("codex");
  });

  it("skips Cursor because Review cannot launch its native agent", () => {
    expect(
      preferredInstalledReviewAgent(status(["cursor", "pi"], ["cursor", "pi"])),
    ).toBe("pi");
    expect(
      preferredInstalledReviewAgent(status(["cursor"], ["cursor"])),
    ).toBeUndefined();
  });
});
