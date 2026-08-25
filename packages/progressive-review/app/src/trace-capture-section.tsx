import type {
  ReviewCanvasInstallContent,
  ReviewCliInstallStatus,
} from "@dev.fast/review-protocol";
import { useEffect, useState } from "react";

import { TARGET_LABELS, supportsFff } from "./agent-setup-card";

/**
 * Experimental trace capture controls. Lives under Settings ▸ Experimental
 * Features only: onboarding never mentions it, and nothing else in the app
 * depends on it being enabled.
 *
 * The on/off state is the machine-level trace setting the review server owns,
 * read back through the install status. Enabling installs the agent hooks and
 * trace skill for every agent already set up; disabling removes them again.
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
  const [traceEndpoint, setTraceEndpoint] = useState(
    install.status.trace.endpoint ?? "",
  );
  const [traceBucket, setTraceBucket] = useState(
    install.status.trace.bucket ?? "",
  );
  const [traceKey, setTraceKey] = useState("");
  const [traceSecret, setTraceSecret] = useState("");

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
          Records agent sessions to your own R2 bucket so reviews can quote
          them. Session hooks activate each Git or Jujutsu repository when an
          agent session starts.
        </span>
      </div>
      <div className="review-agent-setup-trace-fields">
        <input
          aria-label="R2 endpoint URL"
          placeholder="R2 endpoint URL"
          value={traceEndpoint}
          onChange={(event) => setTraceEndpoint(event.currentTarget.value)}
        />
        <input
          aria-label="R2 bucket"
          placeholder="R2 bucket"
          value={traceBucket}
          onChange={(event) => setTraceBucket(event.currentTarget.value)}
        />
        <input
          aria-label="R2 access key ID"
          placeholder={
            status.trace.accessKeyIdPrefix
              ? `Access key (${status.trace.accessKeyIdPrefix}…)`
              : "R2 access key ID"
          }
          value={traceKey}
          onChange={(event) => setTraceKey(event.currentTarget.value)}
        />
        <input
          aria-label="R2 secret access key"
          type="password"
          placeholder={
            status.trace.configured
              ? "Secret key (unchanged)"
              : "R2 secret access key"
          }
          value={traceSecret}
          onChange={(event) => setTraceSecret(event.currentTarget.value)}
        />
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
          void run(
            "trace",
            () =>
              install.apply({
                targets: installedTargets,
                ...(fffTargets.length > 0 ? { fff: true } : {}),
                trace: {
                  ...(traceEndpoint ? { endpoint: traceEndpoint } : {}),
                  ...(traceBucket ? { bucket: traceBucket } : {}),
                  ...(traceKey ? { key: traceKey } : {}),
                  ...(traceSecret ? { secret: traceSecret } : {}),
                },
              }),
            () => {
              setTraceKey("");
              setTraceSecret("");
            },
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
