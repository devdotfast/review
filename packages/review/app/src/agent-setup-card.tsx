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
  opencode: "OpenCode",
  pi: "Pi",
};

type InstallRequest = Pick<
  Parameters<ReviewCanvasInstallContent["apply"]>[0],
  "targets" | "fff"
>;

/**
 * Lets the reviewer connect each agent to Review: an MCP entry for agents
 * that support one, and a small pointer skill for the rest. The card keeps the
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

  return (
    <section className="review-agent-setup" aria-label="Agent setup">
      <ul className="review-agent-setup-agents">
        {status.agents.map((agent) => {
          const Logo = AGENT_LOGOS[agent.target];

          const skills =
            status.skills?.filter((skill) => skill.target === agent.target) ??
            [];

          const mcp = status.mcp?.find((item) => item.target === agent.target);

          const labels = mcp
            ? { idle: "Connect", again: "Reconnect", busy: "Connecting…" }
            : { idle: "Install", again: "Reinstall", busy: "Installing…" };

          const needsUpdate =
            skills.some((skill) => skill.stale) ||
            (agent.installed && mcp?.state === "missing");

          const versions = skills
            .map(
              (skill) =>
                `${skill.name}: installed ${skill.installedVersion ?? "unversioned"}; bundled ${skill.bundledVersion ?? "unversioned"}`,
            )
            .join("\n");

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
                title={versions || undefined}
              >
                {mcp?.state === "error"
                  ? "setup error"
                  : mcp?.state === "custom"
                    ? "custom MCP"
                    : needsUpdate
                      ? "update needed"
                      : agent.installed
                        ? mcp
                          ? "configured"
                          : "installed"
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
                      install.remove(request),
                    )
                  }
                >
                  {busy === `remove-${agent.target}`
                    ? "Removing…"
                    : mcp
                      ? "Disconnect"
                      : "Uninstall"}
                </button>
              ) : null}
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  void run(agent.target, () => install.apply(request))
                }
              >
                {busy === agent.target
                  ? labels.busy
                  : agent.installed
                    ? labels.again
                    : labels.idle}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="review-agent-setup-disclosure">
        Connects your agents to Review&apos;s MCP tools. Agents without MCP
        support get a small Review skill instead.
      </p>
      {error || status.error ? (
        <p className="review-agent-setup-error">{error ?? status.error}</p>
      ) : null}
      {status.skills
        ?.filter((skill) => skill.error)
        .map((skill) => (
          <p
            className="review-agent-setup-error"
            key={`${skill.target}-${skill.name}`}
          >
            {skill.error}
          </p>
        ))}
      {status.mcp
        ?.filter((item) => item.state === "error" || item.state === "custom")
        .map((item) => (
          <p className="review-agent-setup-error" key={item.target}>
            {item.error ??
              `${TARGET_LABELS[item.target]} already has custom Review MCP settings. Remove that entry in your agent's settings, then choose Connect here to let Review manage it.`}
          </p>
        ))}
    </section>
  );
}

export function supportsFff(target: ReviewCliInstallTarget): boolean {
  return target === "claude" || target === "codex" || target === "pi";
}
