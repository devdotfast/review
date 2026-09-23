import type {
  ReviewCanvasInstallContent,
  ReviewCliInstallStatus,
} from "@dev.fast/review-protocol";
import { useEffect, useState } from "react";

type InstallApplyRequest = Parameters<ReviewCanvasInstallContent["apply"]>[0];

type TraceCredentials = Exclude<InstallApplyRequest["trace"], true | undefined>;

/** One line naming the selected trace store and where its setup lives. */
function traceStorageSummary(trace: ReviewCliInstallStatus["trace"]): string {
  if (trace.storageMode === "hosted") {
    return "Storage: hosted trace store selected. Manage it with `review login`, `review trace allow`, and `review trace storage use` in a terminal.";
  }

  if (trace.storageMode === "none" || !trace.configured) {
    return "Storage: none selected. Enter S3/R2 credentials below, or select the hosted store with `review trace storage use hosted`.";
  }

  const source =
    trace.credentialsSource === "profile"
      ? "config.json"
      : trace.credentialsSource === "process-env"
        ? "environment variables"
        : "the legacy env file";

  return `Storage: S3/R2 bucket "${trace.bucket ?? ""}" (credentials from ${source}).`;
}

/** What capture records and where, for the selected store. */
function traceDestinationCopy(trace: ReviewCliInstallStatus["trace"]): string {
  if (trace.storageMode === "hosted") {
    return "Records agent sessions from allowed repositories to the hosted /dev/fast trace store so Whiteboard sessions can quote them. Session hooks activate each Git or Jujutsu repository when an agent session starts.";
  }

  return "Records agent sessions to your own S3/R2 bucket so Whiteboard sessions can quote them. Session hooks activate each Git or Jujutsu repository when an agent session starts.";
}

/**
 * Experimental trace capture controls. Lives under Settings ▸ Experimental
 * Features. The tutorial demonstrates a bundled trace without requiring
 * capture to be enabled.
 *
 * The on/off state is the machine-level trace setting the review server owns,
 * read back through the install status.
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

  const [traceRegion, setTraceRegion] = useState(
    install.status.trace.region ?? "",
  );

  const [traceKey, setTraceKey] = useState("");
  const [traceSecret, setTraceSecret] = useState("");

  useEffect(() => setStatus(install.status), [install.status]);
  const hosted = status.trace.storageMode === "hosted";

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
              : status.trace.storageMode === "hosted"
                ? "enabled (hosted)"
                : "enabled"
            : status.trace.configured
              ? "ready to enable"
              : "off"}
        </span>
        <span className="review-agent-setup-cli">
          {traceDestinationCopy(status.trace)}
        </span>
        <span className="review-agent-setup-cli" data-testid="trace-storage">
          {traceStorageSummary(status.trace)}
        </span>
      </div>
      {hosted ? null : (
        <div className="review-agent-setup-trace-fields">
          <input
            aria-label="S3/R2 endpoint URL"
            placeholder="S3/R2 endpoint URL"
            value={traceEndpoint}
            onChange={(event) => setTraceEndpoint(event.currentTarget.value)}
          />
          <input
            aria-label="S3/R2 bucket"
            placeholder="S3/R2 bucket"
            value={traceBucket}
            onChange={(event) => setTraceBucket(event.currentTarget.value)}
          />
          <input
            aria-label="S3/R2 region"
            placeholder="Region (auto for R2)"
            value={traceRegion}
            onChange={(event) => setTraceRegion(event.currentTarget.value)}
          />
          <input
            aria-label="S3/R2 access key ID"
            placeholder={
              status.trace.accessKeyIdPrefix
                ? `Access key (${status.trace.accessKeyIdPrefix}…)`
                : "S3/R2 access key ID"
            }
            value={traceKey}
            onChange={(event) => setTraceKey(event.currentTarget.value)}
          />
          <input
            aria-label="S3/R2 secret access key"
            type="password"
            placeholder={
              status.trace.configured
                ? "Secret key (unchanged)"
                : "S3/R2 secret access key"
            }
            value={traceSecret}
            onChange={(event) => setTraceSecret(event.currentTarget.value)}
          />
        </div>
      )}
      {status.trace.enabled ? (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() =>
            void run("trace-remove", () => install.remove({ trace: true }))
          }
        >
          {busy === "trace-remove" ? "Disabling…" : "Disable"}
        </button>
      ) : null}
      {hosted ? null : (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() =>
            void run(
              "trace",
              () => {
                const trace: TraceCredentials = {};

                if (traceEndpoint) trace.endpoint = traceEndpoint;

                if (traceBucket) trace.bucket = traceBucket;

                if (traceRegion) trace.region = traceRegion;

                if (traceKey) trace.key = traceKey;

                if (traceSecret) trace.secret = traceSecret;

                return install.apply({ trace });
              },
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
      )}
      {error ? <p className="review-agent-setup-error">{error}</p> : null}
    </div>
  );
}
