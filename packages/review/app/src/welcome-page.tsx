import {
  REVIEW_DISCORD_URL,
  type ReviewCanvasInstallContent,
  type ReviewCanvasOnboarding,
  type ReviewCanvasSetupActions,
  type ReviewCliInstallStatus,
} from "@dev.fast/review-protocol";
import { type ReactNode, useState } from "react";

import { cliInstallReady } from "./cli-install-status";
import { ConnectCard, LegacySkillsRow } from "./connect-card";
import { DisclosureChevron } from "./icons";
import { newTabLinkProps } from "./link-props";
import { PromptCard } from "./prompt-card";

export const REVIEW_CONNECT_COPIED_STORAGE_KEY =
  "dev.fast.review.connectCopied";

/** First-run setup and migration from legacy agent skills to MCP. */
export function WelcomePage({
  install: initialInstall,
  setupActions,
  onClose,
  onDismissUpdate,
  onboarding,
  onOpenTutorial,
}: {
  install?: ReviewCanvasInstallContent;
  setupActions?: ReviewCanvasSetupActions;
  onClose?: () => void;
  onDismissUpdate?: () => void;
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

  const installed = cliInstallReady(status);

  const hasLegacySkills = (status?.legacySkills.length ?? 0) > 0;
  const setupReady = installed && !hasLegacySkills;
  // Once shown, the removal step stays, even if an agent following the
  // connect prompt deletes the skills first.
  const [showLegacyStep, setShowLegacyStep] = useState(hasLegacySkills);
  const updating = (status?.updateNeeded ?? false) || showLegacyStep;

  if (hasLegacySkills && !showLegacyStep) setShowLegacyStep(true);

  const [replaceInstallStep, setReplaceInstallStep] = useState(
    () => installed && hasLegacySkills,
  );

  if (installed && hasLegacySkills && !replaceInstallStep)
    setReplaceInstallStep(true);

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

  const installStep: WelcomeStep = {
    title: "Install the whiteboard command",
    disabled: hasLegacySkills,
    done: installed,
    body: (
      <>
        <p className="review-home-zero-hint">
          {installed ? (
            "Installed at ~/.local/bin/whiteboard."
          ) : status?.shim.installed ? (
            "Add ~/.local/bin to PATH, then refresh."
          ) : (
            <>
              The <code>whiteboard</code> CLI lets your agents talk to
              Whiteboard
            </>
          )}
        </p>
        {setupActions && !installed ? (
          <button
            type="button"
            className="review-onboarding-primary review-onboarding-install"
            disabled={setupBusy}
            onClick={() =>
              void runSetup(async () => {
                await setupActions.installCli();
                await refreshInstall();
              })
            }
          >
            Install whiteboard in PATH
          </button>
        ) : null}
        {setupActions &&
        (!install || (status?.shim.installed && !installed)) ? (
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
  };

  const dismissUpdate = () => {
    if (!install) return;
    void runSetup(async () => {
      setCardStatus(await install.finishUpdate());
      setUpdateFinished(true);
      (onDismissUpdate ?? onClose)?.();
    });
  };

  const steps: WelcomeStep[] = [
    ...(showLegacyStep && install && status
      ? [
          {
            title: "Remove deprecated skills",
            done: !hasLegacySkills,
            body: (
              <LegacySkillsRow
                install={{ ...install, status }}
                onStatusChange={setCardStatus}
              />
            ),
          },
        ]
      : []),
    ...(replaceInstallStep && installed ? [] : [installStep]),
    {
      title: "Connect your agents",
      disabled: !setupReady,
      done: connectCopied || updateFinished,
      note: "paste a prompt into each agent",
      body:
        install && status ? (
          <ConnectCard
            install={{ ...install, status }}
            onCopied={markConnectCopied}
          />
        ) : (
          <p className="review-home-empty">Agent setup is unavailable.</p>
        ),
    },
  ];

  if ((updating || showLegacyStep) && install)
    steps.push({
      title: "Continue shipping beautiful code",
      disabled: hasLegacySkills,
      done: updateFinished,
      body: (
        <button
          type="button"
          className="review-welcome-dismiss review-onboarding-primary"
          disabled={setupBusy || hasLegacySkills}
          onClick={dismissUpdate}
        >
          Dismiss
        </button>
      ),
    });

  if (!updating && !showLegacyStep)
    steps.push(
      {
        title: "Take the tour",
        disabled: !setupReady,
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
        disabled: !setupReady,
        done: onboarding?.published ?? false,
        note: onboarding?.published ? "published" : "your agent writes it",
        body: <PromptCard />,
      },
    );

  // Pick the initial step from progress, then let the reader navigate, so an
  // action never collapses the step it happened in. Keyed by title because
  // the step list changes as install status arrives.
  const [openStep, setOpenStep] = useState(() =>
    updating && installed && !hasLegacySkills
      ? "Connect your agents"
      : steps.find((step) => !step.done)?.title,
  );

  if (openStep && !steps.some((step) => step.title === openStep))
    setOpenStep(steps.find((step) => !step.done && !step.disabled)?.title);

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
                    Whiteboard (fka. Review) no longer installs skills. Your
                    agents connect via MCP which makes updating and lifecycle
                    simpler! To continue using Whiteboard, axe the skills,
                    install the plugin in your harness of choice, and you're
                    good to go.
                  </p>
                </>
              ) : (
                <>
                  <h1 className="review-onboarding-headline">
                    Your codebase, explained by your agent.
                  </h1>
                  <p className="review-onboarding-sub">
                    Install the command then setup the MCP to get started.
                  </p>
                </>
              )}
              {(updating || showLegacyStep) && install ? (
                <button
                  type="button"
                  className="review-welcome-dismiss"
                  disabled={setupBusy || hasLegacySkills}
                  onClick={dismissUpdate}
                >
                  Dismiss
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
                const open = openStep === step.title && !step.disabled;

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
                      disabled={step.disabled}
                      aria-expanded={open}
                      aria-label={`${open ? "Collapse" : "Expand"} ${step.title}`}
                      onClick={() => setOpenStep(open ? undefined : step.title)}
                    >
                      <StepBadge done={step.done} label={String(index + 1)} />
                      <span className="review-onboarding-step-title">
                        {step.title}
                      </span>
                      {step.note ? (
                        <span className="review-onboarding-step-note">
                          {step.note}
                        </span>
                      ) : null}
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
          <p className="review-welcome-feedback">
            {updating || showLegacyStep
              ? "Thoughts on the rename or product direction?"
              : "Questions about getting started? Suggestions for new features?"}{" "}
            Ask us on{" "}
            <a
              href={REVIEW_DISCORD_URL}
              {...newTabLinkProps(REVIEW_DISCORD_URL)}
            >
              Discord
            </a>{" "}
            or ping us at{" "}
            <a href="mailto:founders@dev.fast">founders@dev.fast</a>.
          </p>
        </div>
      </div>
    </main>
  );
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
  disabled?: boolean;
  note?: string;
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
