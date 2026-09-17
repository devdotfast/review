import {
  ReviewApiClient,
  type ReviewApiSummary,
} from "@dev.fast/review-protocol";
import { useEffect, useState } from "react";

import "./project-setup.css";

import type {
  WorkspaceSettings,
  WorkspaceStatus,
} from "../../src/review-api/workspaces";

export function RepositorySetup({
  client,
  repositoryId,
}: {
  client: ReviewApiClient;
  repositoryId: string;
}) {
  const [settings, setSettings] = useState<WorkspaceSettings>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    setSettings(undefined);
    void client
      .read<WorkspaceSettings>(
        `/workspace-settings/${repositoryId}`,
        abort.signal,
      )
      .then(setSettings)
      .catch((error) => {
        if (!abort.signal.aborted) setMessage(String(error));
      });

    return () => abort.abort();
  }, [client, repositoryId]);

  async function save(rebuild: boolean) {
    if (!settings) return;
    setBusy(true);

    try {
      await client.post(`/workspace-settings/${repositoryId}`, settings);

      if (rebuild)
        await client.post(`/workspace-settings/${repositoryId}/rebuild`, {});
      setMessage(
        rebuild
          ? "Rebuilding project environments in the background."
          : "Saved. Existing environments are unchanged.",
      );
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset disabled={busy} className="review-project-setup">
      <legend>Project setup</legend>
      <p>
        Commands run in each managed checkout on this machine. Shared checkouts
        are removed when their last review is deleted.
      </p>
      {settings && (
        <>
          <label>
            Setup command
            <textarea
              rows={3}
              value={settings.setup}
              onChange={(event) =>
                setSettings({ ...settings, setup: event.target.value })
              }
            />
          </label>
          <label>
            Teardown command (optional)
            <textarea
              rows={3}
              value={settings.teardown}
              onChange={(event) =>
                setSettings({ ...settings, teardown: event.target.value })
              }
            />
          </label>
          <button type="button" onClick={() => void save(false)}>
            Save
          </button>{" "}
          <button type="button" onClick={() => void save(true)}>
            Save and rebuild environments
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </fieldset>
  );
}

function WorkspaceRows({
  client,
  rows,
  refresh,
}: {
  client: ReviewApiClient;
  rows: WorkspaceStatus[];
  refresh: () => void;
}) {
  const [error, setError] = useState("");

  return (
    <>
      {rows.map((row) => (
        <div key={row.id} className="review-environment-row">
          <span className="review-environment-state">
            <code>{row.commit.slice(0, 8)}</code>{" "}
            {row.state === "unconfigured" ? "Setup not configured" : row.state}
          </span>{" "}
          {(row.state === "failed" || row.state === "cleanup-failed") && (
            <button
              type="button"
              onClick={() => {
                void client
                  .post(`/workspaces/${row.id}/retry`, {})
                  .then(refresh)
                  .catch((error) => setError(String(error)));
              }}
            >
              Retry
            </button>
          )}
          {row.log && (
            <details className="review-environment-logs">
              <summary>View logs</summary>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  maxHeight: 240,
                  overflow: "auto",
                }}
              >
                {row.log}
              </pre>
            </details>
          )}
        </div>
      ))}
      {error && <p role="status">{error}</p>}
    </>
  );
}

export function ReviewProjectSetup({
  client,
  reviewId,
  version,
  repositoryId,
}: {
  client: ReviewApiClient;
  reviewId: string;
  version: number;
  repositoryId: string;
}) {
  const [rows, setRows] = useState<WorkspaceStatus[]>([]);
  const [error, setError] = useState("");
  const [configure, setConfigure] = useState(false);

  const refresh = () => {
    void client
      .read<WorkspaceStatus[]>(`/${reviewId}/workspaces?version=${version}`)
      .then(setRows)
      .catch((error) => setError(String(error)));
  };

  useEffect(() => {
    let disposed = false;

    const refresh = () =>
      void client
        .read<WorkspaceStatus[]>(`/${reviewId}/workspaces?version=${version}`)
        .then((rows) => {
          if (!disposed) {
            setRows(rows);
            setError("");
          }
        })
        .catch((error) => {
          if (!disposed) setError(String(error));
        });

    refresh();
    const timer = setInterval(refresh, 2500);

    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [client, reviewId, version]);

  const status = error
    ? "Status unavailable"
    : rows.some((row) => row.state === "failed")
      ? "setup failed"
      : rows.some((row) => row.state === "cleanup-failed")
        ? "Cleanup needs attention"
        : rows.some((row) => row.state === "unconfigured")
          ? "Set up language features"
          : rows.some((row) => row.state === "preparing") || !rows.length
            ? "Preparing language features"
            : "Language features ready";

  return (
    <details className="review-environment" open={configure || undefined}>
      <summary className="review-environment-summary">
        <span className="review-environment-indicator" aria-hidden="true" />
        <span>{status}</span>
        <span className="review-environment-action">Manage</span>
        <svg
          className="review-environment-chevron"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="m4 6 4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </summary>
      <div className="review-environment-body">
        <p className="review-environment-description">
          Prepare dependencies to enable hover, definitions, and references. You
          can keep reading while setup runs.
        </p>
        <WorkspaceRows client={client} rows={rows} refresh={refresh} />
        {error && <p role="status">{error}</p>}
        <button type="button" onClick={() => setConfigure(!configure)}>
          {configure ? "Hide configuration" : "Configure project setup"}
        </button>
        {configure && (
          <RepositorySetup client={client} repositoryId={repositoryId} />
        )}
      </div>
    </details>
  );
}

export function ProjectSetupSettings({ client }: { client: ReviewApiClient }) {
  const [repositories, setRepositories] = useState<ReviewApiSummary[]>([]);
  const [repositoryId, setRepositoryId] = useState("");
  const [failures, setFailures] = useState<WorkspaceStatus[]>([]);
  const [error, setError] = useState("");

  const refresh = () =>
    void client
      .read<WorkspaceStatus[]>("/workspace-cleanup")
      .then(setFailures)
      .catch((error) => setError(String(error)));

  useEffect(() => {
    void client
      .read<ReviewApiSummary[]>("/")
      .then((rows) =>
        setRepositories([
          ...new Map(rows.map((row) => [row.pins.repositoryId, row])).values(),
        ]),
      )
      .catch((error) => setError(String(error)));
    refresh();
    const timer = setInterval(refresh, 2500);

    return () => clearInterval(timer);
  }, [client]);

  return (
    <section>
      <h2>Project environments</h2>
      <label>
        Repository{" "}
        <select
          value={repositoryId}
          onChange={(event) => setRepositoryId(event.target.value)}
        >
          <option value="">Select a repository</option>
          {repositories.map((row) => (
            <option key={row.pins.repositoryId} value={row.pins.repositoryId}>
              {row.repositoryPath ?? row.repositoryName}
            </option>
          ))}
        </select>
      </label>
      {repositoryId && (
        <RepositorySetup
          key={repositoryId}
          client={client}
          repositoryId={repositoryId}
        />
      )}
      {failures.length > 0 && (
        <>
          <h3>Cleanup needs attention</h3>
          <WorkspaceRows client={client} rows={failures} refresh={refresh} />
        </>
      )}
      {error && <p role="status">{error}</p>}
    </section>
  );
}
