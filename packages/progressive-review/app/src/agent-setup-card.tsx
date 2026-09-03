import type {
  ReviewCanvasInstallContent,
  ReviewCliInstallStatus,
  ReviewCliInstallTarget,
} from "@dev.fast/review-protocol";
import { useEffect, useState } from "react";

import { AGENT_LOGOS } from "./agent-logos";

export const TARGET_LABELS: Record<ReviewCliInstallTarget, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  pi: "Pi",
};

type InstallRequest = Pick<
  Parameters<ReviewCanvasInstallContent["apply"]>[0],
  "targets" | "fff"
>;

/**
 * Lets the reviewer install or reinstall skills per agent. The card keeps the
 * latest action result so its parent can advance without a host re-render.
 */
export function AgentSetupCard({
  install,
  onStatusChange,
}: {
  install: ReviewCanvasInstallContent;
  onStatusChange?: (status: ReviewCliInstallStatus) => void;
}) {
  const [status, setStatus] = useState<ReviewCliInstallStatus>(install.status);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setStatus(install.status), [install.status]);

  const run = async (
    key: string,
    action: () => Promise<ReviewCliInstallStatus>,
  ) => {
    setBusy(key);
    setError(null);
    try {
      const next = await action();
      setStatus(next);
      onStatusChange?.(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  // FFF belongs to trace capture: manage it when this machine installed the
  // trace hooks, or when a repository may publish traces.
  const traceCapture =
    status.trace.enabled || status.stamp?.traceManaged === true;

  return (
    <section className="review-agent-setup" aria-label="Agent setup">
      <ul className="review-agent-setup-agents">
        {status.agents.map((agent) => {
          const Logo = AGENT_LOGOS[agent.target];
          const request: InstallRequest = { targets: [agent.target] };
          if (status.trace.enabled && supportsFff(agent.target)) {
            request.fff = true;
          }
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
                        ...(traceCapture && supportsFff(agent.target)
                          ? { fff: true }
                          : {}),
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
                      ...(traceCapture && supportsFff(agent.target)
                        ? { fff: true }
                        : {}),
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
      <p className="review-agent-setup-disclosure">
        Installing skills will also install <code>review</code> to your shell
        PATH.
      </p>
      {error ? <p className="review-agent-setup-error">{error}</p> : null}
    </section>
  );
}

export function supportsFff(target: ReviewCliInstallTarget): boolean {
  return target === "claude" || target === "codex" || target === "pi";
}
