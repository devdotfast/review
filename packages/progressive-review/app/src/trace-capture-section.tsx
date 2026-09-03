import type {
  ReviewCanvasInstallContent,
  ReviewCliInstallStatus,
} from "@dev.fast/review-protocol";
import { useEffect, useState } from "react";

import { TARGET_LABELS, supportsFff } from "./agent-setup-card";

type InstallApplyRequest = Parameters<ReviewCanvasInstallContent["apply"]>[0];
type TraceCredentials = Exclude<InstallApplyRequest["trace"], true | undefined>;

/**
 * Experimental trace capture controls. Lives under Settings ▸ Experimental
 * Features only: onboarding never mentions it, and nothing else in the app
 * depends on it being enabled.
 *
 * The on/off state is the machine-level trace setting the review server owns,
 * read back through the install status. Enabling installs the agent hooks and
 * trace skill for every agent already set up; disabling removes them again.
 * The hosted trace store needs no machine credentials: a user runs
 * `review login` once, then `review trace allow .` in each repository that
 * may publish traces.
 */
export function TraceCaptureSection({
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
    onSuccess?: () => void,
  ) => {
    setBusy(key);
    setError(null);
    try {
      const next = await action();
      setStatus(next);
      onStatusChange?.(next);
      onSuccess?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const installedTargets = status.stamp?.targets?.length
    ? status.stamp.targets
    : status.agents
        .filter((agent) => agent.installed)
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

  return (
    <div className="review-agent-setup-terminal review-agent-setup-trace">
      <div className="review-agent-setup-terminal-info">
        <span className="review-agent-setup-name">Trace capture</span>
        <span
          className="review-agent-setup-state"
          data-installed={status.trace.enabled}
          title={status.trace.envPath}
        >
          {status.trace.enabled
            ? status.trace.error
              ? "enabled, storage check failed"
              : "enabled"
            : status.trace.configured
              ? "ready to enable"
              : "off"}
        </span>
        <span className="review-agent-setup-cli">
          Records agent sessions to the hosted trace store so reviews can quote
          them. Run <code>review login</code>, then{" "}
          <code>review trace allow .</code> in each repository that may publish
          traces. Session hooks activate each Git or Jujutsu repository when an
          agent session starts.
        </span>
      </div>
      {status.trace.enabled ? (
        <button
          type="button"
          className="review-agent-setup-subtle"
          disabled={busy !== null}
          onClick={() =>
            void run("trace-remove", () =>
              install.remove({ targets: [], trace: true }),
            )
          }
        >
          {busy === "trace-remove" ? "Disabling…" : "Disable"}
        </button>
      ) : null}
      <button
        type="button"
        disabled={busy !== null}
        onClick={() =>
          void run("trace", () =>
            install.apply({
              targets: installedTargets,
              ...(fffTargets.length > 0 ? { fff: true } : {}),
              trace: true,
            }),
          )
        }
      >
        {busy === "trace"
          ? "Checking…"
          : status.trace.enabled
            ? "Repair"
            : "Enable"}
      </button>
      {status.trace.enabled && fffTargets.length > 0 ? (
        <div className="review-agent-setup-terminal review-agent-setup-trace-search">
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
              {status.fff.binary.installed ? "installed" : "not managed here"}
              {" · "}
              {status.fff.registrations
                .filter((registration) =>
                  fffTargets.includes(registration.target),
                )
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
            disabled={busy !== null}
            onClick={() =>
              void run("fff", () =>
                install.apply({ targets: fffTargets, fff: true }),
              )
            }
          >
            {busy === "fff" ? "Installing…" : fffReady ? "Repair" : "Install"}
          </button>
        </div>
      ) : null}
      {error ? <p className="review-agent-setup-error">{error}</p> : null}
    </div>
  );
}
