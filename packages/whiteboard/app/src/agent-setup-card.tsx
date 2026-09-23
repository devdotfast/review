import type {
  WhiteboardCanvasInstallContent,
  WhiteboardCliInstallStatus,
  WhiteboardCliInstallTarget,
} from "@dev.fast/whiteboard-protocol";
import { useEffect, useState } from "react";

import { AGENT_LOGOS } from "./agent-logos";

export const TARGET_LABELS: Record<WhiteboardCliInstallTarget, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  pi: "Pi",
};

type InstallRequest = Pick<
  Parameters<WhiteboardCanvasInstallContent["apply"]>[0],
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
  install: WhiteboardCanvasInstallContent;
  onStatusChange?: (status: WhiteboardCliInstallStatus) => void;
}) {
  const [status, setStatus] = useState<WhiteboardCliInstallStatus>(
    install.status,
  );

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setStatus(install.status), [install.status]);

  const run = async (
    key: string,
    action: () => Promise<WhiteboardCliInstallStatus>,
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
    <section className="whiteboard-agent-setup" aria-label="Agent setup">
      <ul className="whiteboard-agent-setup-agents">
        {status.agents.map((agent) => {
          const Logo = AGENT_LOGOS[agent.target];

          const skills =
            status.skills?.filter((skill) => skill.target === agent.target) ??
            [];

          const mcp = status.mcp?.find((item) => item.target === agent.target);

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
                className="whiteboard-agent-setup-logo-slot"
                data-present={agent.present}
              >
                <Logo />
              </span>
              <span className="whiteboard-agent-setup-name">
                {TARGET_LABELS[agent.target]}
              </span>
              <span
                className="whiteboard-agent-setup-state"
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
                        ? "installed"
                        : agent.present
                          ? "detected"
                          : "not detected"}
              </span>
              {agent.installed ? (
                <button
                  type="button"
                  className="whiteboard-agent-setup-subtle"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(`remove-${agent.target}`, () =>
                      install.remove(request),
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
                  void run(agent.target, () => install.apply(request))
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
      <p className="whiteboard-agent-setup-disclosure">
        Installs Whiteboard skills, the <code>whiteboard</code> command, and MCP
        tools where supported.
      </p>
      {error || status.error ? (
        <p className="whiteboard-agent-setup-error">{error ?? status.error}</p>
      ) : null}
      {status.skills
        ?.filter((skill) => skill.error)
        .map((skill) => (
          <p
            className="whiteboard-agent-setup-error"
            key={`${skill.target}-${skill.name}`}
          >
            {skill.error}
          </p>
        ))}
      {status.mcp
        ?.filter((item) => item.state === "error" || item.state === "custom")
        .map((item) => (
          <p className="whiteboard-agent-setup-error" key={item.target}>
            {item.error ??
              `${TARGET_LABELS[item.target]} already has custom Whiteboard MCP settings. Remove that entry in your agent's settings, then reinstall here to let Whiteboard manage it.`}
          </p>
        ))}
    </section>
  );
}

export function supportsFff(target: WhiteboardCliInstallTarget): boolean {
  return target === "claude" || target === "codex" || target === "pi";
}
