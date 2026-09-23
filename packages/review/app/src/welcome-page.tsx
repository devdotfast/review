import type {
  ReviewCanvasInstallContent,
  ReviewCanvasOnboarding,
  ReviewCanvasSetupActions,
  ReviewCliInstallStatus,
} from "@dev.fast/review-protocol";
import { type ReactNode, useState } from "react";

import { ConnectCard, LegacySkillsRow } from "./connect-card";
import { DisclosureChevron } from "./icons";
import { PromptCard } from "./prompt-card";

export const REVIEW_CONNECT_COPIED_STORAGE_KEY =
  "dev.fast.review.connectCopied";

/**
 * The Welcome pane: the whole first-run experience in one place. It opens
 * automatically on first run (no consent stamp yet) and later from the
 * application menu or the command palette.
 *
 * The four steps are the product's own order — install the whiteboard command,
 * connect an agent, read the bundled tutorial, publish a review of your own
 * repo. Step two embeds the connect prompts, so this pane is also where
 * agents are connected later; there is no separate setup surface. `onClose`
 * closes the tab.
 *
 * An install from before Whiteboard connected over MCP opens this pane in update
 * mode: step two also lists the skills that version installed, and Done
 * records that the update is finished.
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
  install?: ReviewCanvasInstallContent;
  setupActions?: ReviewCanvasSetupActions;
  onClose?: () => void;
  onboarding?: ReviewCanvasOnboarding;
  onOpenTutorial?: () => void;
}) {
  const [loadedInstall, setLoadedInstall] =
    useState<ReviewCanvasInstallContent>();

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

  /* The host renders this pane once per open, so an action taken while it is
     on screen has to advance the rail itself. Each action hands back the
     refreshed status; until the first one, the host's copy is correct. */
  const [cardStatus, setCardStatus] = useState<
    ReviewCliInstallStatus | undefined
  >(undefined);

  const status = cardStatus ?? install?.status;

  const refreshInstall = async () => {
    if (!setupActions) return;
    setLoadedInstall(await setupActions.load());
    setCardStatus(undefined);
  };

  const installed = status
    ? onboardingSetupComplete(status)
    : (onboarding?.installed ?? false);

  const updating = status?.updateNeeded ?? false;

  // Whiteboard cannot see agent configs, so a copied prompt or command is the
  // closest signal that an agent got connected.
  const [connectCopied, setConnectCopied] = useState(readConnectCopied);
  const [updateFinished, setUpdateFinished] = useState(false);

  const markConnectCopied = () => {
    setConnectCopied(true);

    try {
      globalThis.localStorage?.setItem(REVIEW_CONNECT_COPIED_STORAGE_KEY, "1");
    } catch {
      // The desktop can disable DOM storage; the in-memory flag still works.
    }
  };

  const tourChecked = onboarding?.tutorialChecked ?? 0;
  const tourTotal = onboarding?.tutorialTotal ?? 0;

  const steps: WelcomeStep[] = [
    {
      title: "Install the whiteboard command",
      done: installed,
      note: "writes ~/.local/bin/review",
      body: (
        <>
          <p className="review-home-zero-hint">
            Agents start Whiteboard through this command, so install it before
            connecting them.
          </p>
          {installed && status?.shim.installed ? (
            <p className="review-home-zero-hint">
              Installed at {status.shim.path}.
            </p>
          ) : null}
          {setupActions && !installed ? (
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
              Install review in PATH
            </button>
          ) : null}
          {setupActions && !install ? (
            <button
              type="button"
              disabled={setupBusy}
              onClick={() => void runSetup(refreshInstall)}
            >
              {setupBusy ? "Refreshing…" : "Refresh"}
            </button>
          ) : null}
          {setupError ? (
            <p role="alert" className="review-agent-setup-error">
              {setupError}
            </p>
          ) : null}
        </>
      ),
    },
    {
      title: "Connect your agents",
      done: connectCopied || updateFinished,
      note: "paste a prompt into each agent",
      body:
        install && status ? (
          <>
            {updating ? (
              <LegacySkillsRow
                install={{ ...install, status }}
                onStatusChange={setCardStatus}
              />
            ) : null}
            <ConnectCard
              install={{ ...install, status }}
              onCopied={markConnectCopied}
            />
          </>
        ) : (
          <p className="review-home-empty">Agent setup is unavailable.</p>
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
          <p className="review-home-zero-hint">
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
      body: <PromptCard />,
    },
  ];

  // Pick the initial step from progress, then let the reader navigate, so an
  // action never collapses the step it happened in. An update opens on step
  // two, where the old skills and the prompts are.
  const [activeStep, setOpenStep] = useState(() =>
    updating ? 1 : steps.findIndex((step) => !step.done),
  );

  return (
    <main className="review-home">
      <div className="review-home-scroll">
        <div className="review-home-content review-welcome-page">
          <div className="review-onboarding-columns">
            <div className="review-onboarding-intro">
              <span className="review-onboarding-kicker">
                Welcome to Whiteboard
              </span>
              {updating ? (
                <>
                  <h1 className="review-onboarding-headline">
                    Whiteboard now connects to your agents over MCP
                  </h1>
                  <p className="review-onboarding-sub">
                    Whiteboard no longer installs skills. Paste a prompt into
                    each agent you use, and remove the skills earlier versions
                    installed.
                  </p>
                </>
              ) : (
                <>
                  <h1 className="review-onboarding-headline">
                    Your codebase, explained by your agent.
                  </h1>
                  <p className="review-onboarding-sub">
                    Install the command. Connect your agent. Explore a review.
                    Create your own.
                  </p>
                </>
              )}
              {updating && install ? (
                <button
                  type="button"
                  className="review-welcome-dismiss"
                  disabled={setupBusy}
                  onClick={() =>
                    void runSetup(async () => {
                      setCardStatus(await install.finishUpdate());
                      setUpdateFinished(true);
                      onClose?.();
                    })
                  }
                >
                  Done
                </button>
              ) : onClose ? (
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

function onboardingSetupComplete(status: ReviewCliInstallStatus): boolean {
  return !status.cli || status.shim.installed;
}

function readConnectCopied(): boolean {
  try {
    return (
      globalThis.localStorage?.getItem(REVIEW_CONNECT_COPIED_STORAGE_KEY) ===
      "1"
    );
  } catch {
    return false;
  }
}

interface WelcomeStep {
  title: string;
  done: boolean;
  note: string;
  body: ReactNode;
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
