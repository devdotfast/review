import type {
  ReviewCanvasInstallContent,
  ReviewCanvasOnboarding,
  ReviewCliInstallStatus,
} from "@dev.fast/review-protocol";
import { type ReactNode, useState } from "react";

import { AgentSetupCard, TARGET_LABELS } from "./agent-setup-card";
import { DisclosureChevron } from "./icons";
import { PromptCard, promptAgent } from "./prompt-card";

/**
 * The Welcome pane: the whole first-run experience in one place. It opens
 * automatically on first run (no consent stamp yet) and later from the
 * application menu or the command palette.
 *
 * The three steps are the product's own order — connect an agent, read the
 * bundled tutorial, publish a review of your own repo. Step one embeds the
 * agent install card, so this pane is also where agents are managed later;
 * there is no separate setup surface. `onClose` closes the tab.
 *
 * Only one step is open at a time, and each one checks off from a real
 * signal rather than a manual checkbox.
 */
export function WelcomePage({
  install,
  onClose,
  onboarding,
  onOpenTutorial,
}: {
  install?: ReviewCanvasInstallContent;
  onClose?: () => void;
  onboarding?: ReviewCanvasOnboarding;
  onOpenTutorial?: () => void;
}) {
  /* The host renders this pane once per open, so an install or uninstall
     that happens while it is on screen has to advance the rail itself. The
     card hands back the refreshed status after every action; until the
     first one, the host's copy is correct. */
  const [cardStatus, setCardStatus] = useState<
    ReviewCliInstallStatus | undefined
  >(undefined);
  const status = cardStatus ?? install?.status;
  const installed = status
    ? status.agents.some((agent) => agent.installed)
    : (onboarding?.installed ?? false);
  const tourChecked = onboarding?.tutorialChecked ?? 0;
  const tourTotal = onboarding?.tutorialTotal ?? 0;
  const steps: WelcomeStep[] = [
    {
      title: "Connect your agents",
      done: installed,
      note: installedLabels(status) ?? "not installed yet",
      body: install ? (
        <AgentSetupCard
          install={install}
          onSkip={onClose}
          embedded
          onStatusChange={setCardStatus}
        />
      ) : (
        <p className="review-home-empty">
          The install status is unavailable. Restart Review Desktop and open
          this pane again.
        </p>
      ),
    },
    {
      title: "Take the tour",
      done: tourTotal > 0 && tourChecked >= tourTotal,
      note: onboarding
        ? `${tourChecked} of ${tourTotal} checks`
        : "a three-minute sample review",
      body: (
        <>
          <p className="review-home-zero-hint">
            A real review of a small sample repo, with live code and system
            views. Three minutes, no agent needed.
          </p>
          {onOpenTutorial ? (
            <button type="button" onClick={onOpenTutorial}>
              {tourChecked > 0 ? "Reopen the tutorial" : "Open the tutorial"}
            </button>
          ) : null}
        </>
      ),
    },
    {
      title: "Create your first review",
      done: onboarding?.published ?? false,
      note: onboarding?.published ? "published" : "your agent writes it",
      body: <PromptCard agent={promptAgent(status)} />,
    },
  ];

  /* "auto" follows progress: the first unfinished step is open. Clicking a
     header pins a step (or -1 for none) until the pane remounts, which it
     does whenever another canvas kind renders. */
  const [openStep, setOpenStep] = useState<number | "auto">("auto");
  const firstUnfinished = steps.findIndex((step) => !step.done);
  const activeStep = openStep === "auto" ? firstUnfinished : openStep;

  return (
    <main className="review-home">
      <div className="review-home-scroll">
        <div className="review-home-content review-welcome-page">
          <div className="review-onboarding-columns">
            <div className="review-onboarding-intro">
              <span className="review-onboarding-kicker">
                Welcome to Review
              </span>
              <h1 className="review-onboarding-headline">
                Your codebase, explained by your agent.
              </h1>
              <p className="review-onboarding-sub">
                Connect a coding agent once, then take a three-minute tour on a
                bundled sample review. Your agent writes the next one from your
                own repo.
              </p>
              <div className="review-onboarding-terminal">
                <span className="review-onboarding-terminal-label">
                  Prefer the terminal?
                </span>
                <code>$ review install</code>
              </div>
              {onClose ? (
                <button
                  type="button"
                  className="review-welcome-dismiss"
                  onClick={onClose}
                >
                  Close
                </button>
              ) : null}
            </div>
            <ol className="review-onboarding-steps">
              {steps.map((step, index) => {
                const open = activeStep === index;
                return (
                  <li
                    key={step.title}
                    className="review-onboarding-step"
                    data-state={step.done ? "done" : "todo"}
                    data-open={open}
                  >
                    <button
                      type="button"
                      className="review-onboarding-step-header"
                      aria-expanded={open}
                      aria-label={`${open ? "Collapse" : "Expand"} ${step.title}`}
                      onClick={() => setOpenStep(open ? -1 : index)}
                    >
                      <StepBadge done={step.done} label={String(index + 1)} />
                      <span className="review-onboarding-step-title">
                        {step.title}
                      </span>
                      <span className="review-onboarding-step-note">
                        {step.note}
                      </span>
                      <DisclosureChevron expanded={open} />
                    </button>
                    {open ? (
                      <div className="review-onboarding-step-body">
                        {step.body}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      </div>
    </main>
  );
}

interface WelcomeStep {
  title: string;
  done: boolean;
  note: string;
  body: ReactNode;
}

/** Names the agents that are set up, so the collapsed row says something the
 * expanded rows do not repeat. */
function installedLabels(
  status: ReviewCliInstallStatus | undefined,
): string | null {
  const installed = (status?.agents ?? []).filter((agent) => agent.installed);
  if (installed.length === 0) return null;
  return installed.map((agent) => TARGET_LABELS[agent.target]).join(", ");
}

function StepBadge({ done, label }: { done: boolean; label: string }) {
  return (
    <span className="review-onboarding-step-badge" data-done={done}>
      {done ? (
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1.5 5.5 4 8l4.5-6" fill="none" strokeWidth="1.6" />
        </svg>
      ) : (
        label
      )}
    </span>
  );
}
