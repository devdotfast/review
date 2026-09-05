import type {
  ReviewCliInstallStatus,
  ReviewCliInstallTarget,
} from "@dev.fast/review-protocol";

import type { ReviewAgentHarness } from "./authoring-session";

const LAUNCHABLE_HARNESS: Partial<
  Record<ReviewCliInstallTarget, ReviewAgentHarness>
> = {
  claude: "claude-code",
  codex: "codex",
  opencode: "opencode",
  pi: "pi",
};

/** Selects the first installed native agent, preserving onboarding order. */
export function preferredInstalledReviewAgent(
  status: Pick<ReviewCliInstallStatus, "agents" | "stamp">,
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
    const harness = LAUNCHABLE_HARNESS[target];
    if (!installed.has(target) || !harness) continue;
    return harness;
  }
  return undefined;
}
