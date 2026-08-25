import type {
  ReviewCanvasInstallContent,
  ReviewCliInstallStatus,
  ReviewCliInstallTarget,
} from "@dev.fast/review-protocol";
import { useState } from "react";

import { AGENT_LOGOS } from "./agent-logos";

export const TARGET_LABELS: Record<ReviewCliInstallTarget, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  pi: "Pi",
};

/**
 * Card that shows the app-managed CLI + skills install and lets the reviewer
 * install or reinstall per agent. Status updates come back from the install
 * actions themselves, so the card owns a local copy of the status.
 *
 * Before the first consent (no stamp) the card leads with a one-click
 * first-run block: install everything, skip, or turn the auto-open off.
 *
 * `embedded` drops the card's own header — the onboarding page supplies the
 * heading instead. `manageOnly` also drops the one-click first-run block:
 * Settings manages what is installed, it does not onboard. `onStatusChange`
 * reports the refreshed status after every action, so the surrounding page
 * can advance without waiting for the host to re-render.
 */
export function AgentSetupCard({
  install,
  onSkip,
  embedded,
  manageOnly,
  onStatusChange,
}: {
  install: ReviewCanvasInstallContent;
  onSkip?: () => void;
  embedded?: boolean;
  manageOnly?: boolean;
  onStatusChange?: (status: ReviewCliInstallStatus) => void;
}) {
  const [status, setStatus] = useState<ReviewCliInstallStatus>(install.status);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (
    key: string,
    action: () => Promise<ReviewCliInstallStatus>,
    onSuccess?: (status: ReviewCliInstallStatus) => void,
  ) => {
    setBusy(key);
    setError(null);
    try {
      const next = await action();
      setStatus(next);
      onStatusChange?.(next);
      onSuccess?.(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const staleTargets = status.stamp?.targets?.length
    ? status.stamp.targets
    : status.agents
        .filter((agent) => agent.installed)
        .map((agent) => agent.target);

  const presentTargets = status.agents
    .filter((agent) => agent.present)
    .map((agent) => agent.target);
  const fffTargets = status.agents
    .filter(
      (agent) =>
        supportsFff(agent.target) &&
        (agent.present ||
          agent.installed ||
          status.fff.registrations.some(
            (registration) =>
              registration.target === agent.target && registration.present,
          )),
    )
    .map((agent) => agent.target);
  const fffReady =
    fffTargets.length > 0 &&
    fffTargets.every((target) =>
      status.fff.registrations.some(
        (registration) =>
          registration.target === target && registration.present,
      ),
    );
  const firstRun = !status.stamp || status.stamp.consent === "skipped";

  return (
    <section className="review-agent-setup" aria-label="Agent setup">
      {embedded ? null : (
        <>
          <div className="review-agent-setup-header">
            <h2>Agent setup</h2>
            <span className="review-agent-setup-cli">
              {status.cli
                ? `This app bundles Review CLI v${status.cli.version}`
                : "This app has no built Review CLI"}
            </span>
          </div>
          <p className="review-agent-setup-subtitle">
            Install puts the Review skills in each agent's skills folder.
          </p>
        </>
      )}
      {firstRun && status.cli && !manageOnly ? (
        <div className="review-agent-setup-firstrun">
          <p>
            {presentTargets.length > 0
              ? "One click installs the Review skills for your agents and the "
              : "No coding agents were detected on this machine. You can still install the "}
            <code>review</code> terminal command.
          </p>
          {fffTargets.length > 0 ? (
            <p>
              This action also installs FFF when needed. It registers the
              standard <code>fff</code> server for Claude and Codex, and
              installs the Pi FFF extension.
            </p>
          ) : null}
          <div className="review-agent-setup-firstrun-actions">
            <button
              type="button"
              className="review-agent-setup-primary"
              disabled={busy !== null}
              onClick={() =>
                void run("firstrun", () =>
                  install.apply({
                    targets: presentTargets,
                    shim: true,
                    fff: fffTargets.length > 0,
                  }),
                )
              }
            >
              {busy === "firstrun"
                ? "Installing…"
                : presentTargets.length > 0
                  ? `Install for ${presentTargets
                      .map((target) => TARGET_LABELS[target])
                      .join(", ")}`
                  : "Install the review command"}
            </button>
            {onSkip ? (
              <button
                type="button"
                className="review-agent-setup-subtle"
                disabled={busy !== null}
                onClick={() => void run("skip", () => install.skip(), onSkip)}
              >
                {busy === "skip" ? "Skipping…" : "Skip for now"}
              </button>
            ) : null}
            <button
              type="button"
              className="review-agent-setup-subtle"
              disabled={busy !== null}
              onClick={() => void run("decline", () => install.decline())}
            >
              {busy === "decline" ? "Turning off…" : "Don't ask again"}
            </button>
          </div>
        </div>
      ) : null}
      {status.stale ? (
        <div className="review-agent-setup-banner">
          <span>The installed skills are older than this app.</span>
          <button
            type="button"
            disabled={busy !== null || staleTargets.length === 0}
            onClick={() =>
              void run("all", () =>
                install.apply({
                  targets: staleTargets,
                  shim: Boolean(status.stamp?.shimPath),
                }),
              )
            }
          >
            {busy === "all" ? "Updating…" : "Update all"}
          </button>
        </div>
      ) : null}
      <ul className="review-agent-setup-agents">
        {status.agents.map((agent) => {
          const Logo = AGENT_LOGOS[agent.target];
          return (
            <li key={agent.target}>
              <span
                className="review-agent-setup-logo-slot"
                data-present={agent.present}
              >
                <Logo />
              </span>
              <span className="review-agent-setup-name">
                {TARGET_LABELS[agent.target]}
              </span>
              <span
                className="review-agent-setup-state"
                data-installed={agent.installed}
              >
                {agent.installed
                  ? "installed"
                  : agent.present
                    ? "detected"
                    : "not detected"}
              </span>
              {agent.installed ? (
                <button
                  type="button"
                  className="review-agent-setup-subtle"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(`remove-${agent.target}`, () =>
                      install.remove({
                        targets: [agent.target],
                        ...(supportsFff(agent.target) ? { fff: true } : {}),
                      }),
                    )
                  }
                >
                  {busy === `remove-${agent.target}`
                    ? "Removing…"
                    : "Uninstall"}
                </button>
              ) : null}
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  void run(agent.target, () =>
                    install.apply({
                      targets: [agent.target],
                      ...(supportsFff(agent.target) ? { fff: true } : {}),
                    }),
                  )
                }
              >
                {busy === agent.target
                  ? "Installing…"
                  : agent.installed
                    ? "Reinstall"
                    : "Install"}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="review-agent-setup-terminal">
        <div className="review-agent-setup-terminal-info">
          <span className="review-agent-setup-name">Trace search</span>
          <span
            className="review-agent-setup-state"
            data-installed={fffReady}
            title={`${status.fff.binary.path} · ${status.fff.corpusRoot}`}
          >
            {fffReady
              ? "ready"
              : status.fff.binary.installed
                ? "registration needed"
                : "not installed"}
          </span>
          <span className="review-agent-setup-cli">
            FFF MCP binary:{" "}
            {status.fff.binary.installed ? "installed" : "not managed here"} ·{" "}
            {status.fff.registrations
              .map(
                (registration) =>
                  `${TARGET_LABELS[registration.target]}: ${registration.present ? (registration.target === "pi" ? "installed" : "registered") : "missing"}`,
              )
              .join(" · ")}
          </span>
          <span className="review-agent-setup-cli">
            Existing FFF integrations stay unchanged. Open a new agent session
            after setup.
          </span>
        </div>
        <button
          type="button"
          disabled={busy !== null || fffTargets.length === 0}
          onClick={() =>
            void run("fff", () =>
              install.apply({ targets: fffTargets, fff: true }),
            )
          }
        >
          {busy === "fff" ? "Installing…" : fffReady ? "Repair" : "Install"}
        </button>
      </div>
      {status.cli ? (
        <div className="review-agent-setup-terminal">
          <div className="review-agent-setup-terminal-info">
            <span className="review-agent-setup-name">
              <code>review</code> terminal command
            </span>
            <span
              className="review-agent-setup-state"
              data-installed={Boolean(status.stamp?.shimPath)}
              title={status.shim.path}
            >
              {status.stamp?.shimPath
                ? status.shim.onPath
                  ? "installed"
                  : "installed, not on PATH"
                : "not installed"}
            </span>
          </div>
          {status.stamp?.shimPath ? (
            <button
              type="button"
              className="review-agent-setup-subtle"
              disabled={busy !== null}
              onClick={() =>
                void run("remove-command", () =>
                  install.remove({ targets: [], shim: true }),
                )
              }
            >
              {busy === "remove-command" ? "Removing…" : "Uninstall"}
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy !== null}
            onClick={() =>
              void run("command", () =>
                install.apply({ targets: [], shim: true }),
              )
            }
          >
            {busy === "command"
              ? "Installing…"
              : status.stamp?.shimPath
                ? "Reinstall"
                : "Install command"}
          </button>
        </div>
      ) : null}
      {status.stamp?.consent === "declined" ? (
        <div className="review-agent-setup-footer">
          <span>Setup does not open at startup.</span>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void run("prompts", () => install.enablePrompts())}
          >
            {busy === "prompts" ? "Turning on…" : "Turn on"}
          </button>
        </div>
      ) : null}
      {error ? <p className="review-agent-setup-error">{error}</p> : null}
    </section>
  );
}

function supportsFff(target: ReviewCliInstallTarget): boolean {
  return target === "claude" || target === "codex" || target === "pi";
}
