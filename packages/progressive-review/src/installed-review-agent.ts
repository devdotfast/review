import type { ReviewCliInstallStatus } from "@dev.fast/review-protocol";

import type { ReviewAgentHarness } from "./authoring-session";

const LAUNCHABLE_HARNESS = {
  claude: "claude-code",
  codex: "codex",
  pi: "pi",
} as const satisfies Record<string, ReviewAgentHarness>;

/** Selects the first installed native agent, preserving onboarding order. */
export function preferredInstalledReviewAgent(
  status: ReviewCliInstallStatus,
): ReviewAgentHarness | undefined {
  const installed = new Set(
    status.agents
      .filter((agent) => agent.installed)
      .map((agent) => agent.target),
  );
  const orderedTargets = [
    ...(status.stamp?.targets ?? []),
    ...status.agents.map((agent) => agent.target),
  ];
  for (const target of new Set(orderedTargets)) {
    if (!installed.has(target) || !(target in LAUNCHABLE_HARNESS)) continue;
    return LAUNCHABLE_HARNESS[target as keyof typeof LAUNCHABLE_HARNESS];
  }
  return undefined;
}
