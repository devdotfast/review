import type {
  WhiteboardCanvasInstallContent,
  WhiteboardCanvasOnboarding,
  WhiteboardCanvasSetupActions,
  WhiteboardCliInstallStatus,
} from "@dev.fast/whiteboard-protocol";
import { type ReactNode, useState } from "react";

import { AgentSetupCard, TARGET_LABELS } from "./agent-setup-card";
import { DisclosureChevron, RefreshIcon } from "./icons";
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
  install: initialInstall,
  setupActions,
  onClose,
  onboarding,
  onOpenTutorial,
}: {
  install?: WhiteboardCanvasInstallContent;
  setupActions?: WhiteboardCanvasSetupActions;
  onClose?: () => void;
  onboarding?: WhiteboardCanvasOnboarding;
  onOpenTutorial?: () => void;
}) {
  const [loadedInstall, setLoadedInstall] =
    useState<WhiteboardCanvasInstallContent>();

  const [setupError, setSetupError] = useState<string>();
  const [setupBusy, setSetupBusy] = useState(false);
  const install = loadedInstall ?? initialInstall;

  const runSetup = async (action: () => Promise<void>) => {
    setSetupBusy(true);
    setSetupError(undefined);

    try {
      await action();
    } catch (cause) {
      setSetupError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSetupBusy(false);
    }
  };

  /* The host renders this pane once per open, so an install or uninstall
     that happens while it is on screen has to advance the rail itself. The
     card hands back the refreshed status after every action; until the
     first one, the host's copy is correct. */
  const [cardStatus, setCardStatus] = useState<
    WhiteboardCliInstallStatus | undefined
  >(undefined);

  const status = cardStatus ?? install?.status;

  const hasAgents =
    status?.agents.some((agent) => agent.present || agent.installed) ?? false;

  const compactRefresh = hasAgents && !setupError;

  const refreshInstall = async () => {
    if (!setupActions) return;
    setLoadedInstall(await setupActions.load());
    setCardStatus(undefined);
  };

  const installed = status
    ? onboardingSetupComplete(status)
    : (onboarding?.installed ?? false);

  const tourChecked = onboarding?.tutorialChecked ?? 0;
  const tourTotal = onboarding?.tutorialTotal ?? 0;

  const steps: WelcomeStep[] = [
    {
      title: "Connect your agents",
      done: installed,
      note: installedLabels(status) ?? "not installed yet",
      body: (
        <>
          {install && hasAgents ? (
            <AgentSetupCard
              install={{ ...install, status: status ?? install.status }}
              onStatusChange={setCardStatus}
            />
          ) : (
            <>
              <p className="whiteboard-home-empty">
                {install
                  ? "No coding agents detected."
                  : "Agent setup is unavailable."}{" "}
                Install <code>whiteboard</code> to get started.
              </p>
              {status?.shim.installed ? (
                <p>
                  <code>whiteboard</code> command installed.
                </p>
              ) : null}
              {setupActions ? (
                <button
                  type="button"
                  disabled={setupBusy}
                  onClick={() =>
                    void runSetup(async () => {
                      await setupActions.installCli();
                      await refreshInstall();
                    })
                  }
                >
                  {status?.shim.installed
                    ? "Reinstall whiteboard in PATH"
                    : "Install whiteboard in PATH"}
                </button>
              ) : null}
            </>
          )}
          {setupActions ? (
            <button
              type="button"
              disabled={setupBusy}
              className={
                compactRefresh ? "whiteboard-onboarding-refresh" : undefined
              }
              aria-label={setupBusy ? "Refreshing agents" : "Refresh agents"}
              title="Refresh agents"
              onClick={() => void runSetup(refreshInstall)}
            >
              {compactRefresh ? (
                <RefreshIcon />
              ) : setupBusy ? (
                "Refreshing…"
              ) : (
                "Refresh agents"
              )}
            </button>
          ) : null}
          {setupError ? (
            <p role="alert" className="whiteboard-agent-setup-error">
              {setupError}
            </p>
          ) : null}
        </>
      ),
    },
    {
      title: "Take the tour",
      done: tourTotal > 0 && tourChecked >= tourTotal,
      note: onboarding
        ? `${tourChecked} of ${tourTotal} checks`
        : "a three-minute sample session",
      body: (
        <>
          <p className="whiteboard-home-zero-hint">
            Explore a sample session in three minutes.
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
      title: "Create your first session",
      done: onboarding?.published ?? false,
      note: onboarding?.published ? "published" : "your agent writes it",
      body: <PromptCard agent={promptAgent(status)} />,
    },
  ];

  // Pick the initial step from progress, then let the reader navigate. An
  // installation must leave its confirmation visible and other agents usable.
  const [activeStep, setOpenStep] = useState(() =>
    steps.findIndex((step) => !step.done),
  );

  return (
    <main className="whiteboard-home">
      <div className="whiteboard-home-scroll">
        <div className="whiteboard-home-content whiteboard-welcome-page">
          <div className="whiteboard-onboarding-columns">
            <div className="whiteboard-onboarding-intro">
              <span className="whiteboard-onboarding-kicker">
                Welcome to Whiteboard
              </span>
              <h1 className="whiteboard-onboarding-headline">
                Your codebase, explained by your agent.
              </h1>
              <p className="whiteboard-onboarding-sub">
                Connect your agent. Explore a session. Create your own.
              </p>
              {onClose ? (
                <button
                  type="button"
                  className="whiteboard-welcome-dismiss"
                  onClick={onClose}
                >
                  Close
                </button>
              ) : null}
            </div>
            <ol className="whiteboard-onboarding-steps">
              {steps.map((step, index) => {
                const open = activeStep === index;

                return (
                  <li
                    key={step.title}
                    className="whiteboard-onboarding-step"
                    data-state={step.done ? "done" : "todo"}
                    data-open={open}
                  >
                    <button
                      type="button"
                      className="whiteboard-onboarding-step-header"
                      aria-expanded={open}
                      aria-label={`${open ? "Collapse" : "Expand"} ${step.title}`}
                      onClick={() => setOpenStep(open ? -1 : index)}
                    >
                      <StepBadge done={step.done} label={String(index + 1)} />
                      <span className="whiteboard-onboarding-step-title">
                        {step.title}
                      </span>
                      <span className="whiteboard-onboarding-step-note">
                        {step.note}
                      </span>
                      <DisclosureChevron expanded={open} />
                    </button>
                    {open ? (
                      <div className="whiteboard-onboarding-step-body">
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

function onboardingSetupComplete(status: WhiteboardCliInstallStatus): boolean {
  const installedAgents = status.agents.filter((agent) => agent.installed);

  if (installedAgents.length === 0) return false;

  // Optional trace-search registrations are managed in Settings and do not
  // determine whether Whiteboard skills are installed.
  return !status.cli || status.shim.installed;
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
  status: WhiteboardCliInstallStatus | undefined,
): string | null {
  const installed = (status?.agents ?? []).filter((agent) => agent.installed);

  if (installed.length === 0) return null;

  return installed.map((agent) => TARGET_LABELS[agent.target]).join(", ");
}

function StepBadge({ done, label }: { done: boolean; label: string }) {
  return (
    <span className="whiteboard-onboarding-step-badge" data-done={done}>
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
