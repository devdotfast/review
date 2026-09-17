import { useEffect, useState } from "react";

import type { ReviewApiClient } from "../../src/review-api/client";
import type { WorkspaceStatus } from "../../src/review-api/workspaces";

/** Preparation is local state, independent of the authored document/version. */
export function ProjectPreparation({
  client,
  reviewId,
}: {
  client: ReviewApiClient;
  reviewId: string;
}) {
  const [environments, setEnvironments] = useState<WorkspaceStatus[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setEnvironments([]);
    setError(undefined);

    const refresh = async () => {
      try {
        const [current, cleanup] = await Promise.all([
          client.read<WorkspaceStatus[]>(
            `/${reviewId}/workspaces`,
            abort.signal,
          ),
          client.read<WorkspaceStatus[]>("/workspace-cleanup", abort.signal),
        ]);

        const next = [...current, ...cleanup];

        if (!abort.signal.aborted) {
          setEnvironments(next);
          setError(undefined);
        }
      } catch (cause) {
        if (!abort.signal.aborted) setError(String(cause));
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(refresh, 1500);
      }
    };

    void refresh();

    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [client, reviewId]);

  if (!environments.length && !error) return null;

  const preparing = environments.some(
    (item) => item.state === "pending" || item.state === "preparing",
  );

  const incomplete = environments.some((item) => item.state !== "ready");

  return (
    <details style={{ margin: "8px 24px", fontSize: 12 }}>
      <summary>
        {preparing
          ? "Preparing language environment…"
          : incomplete || error
            ? "Language environment needs attention"
            : "Language environment ready"}
      </summary>
      {error && <p role="alert">{error}</p>}
      {environments.map((item) => (
        <div key={item.id} data-review-workspace-id={item.id}>
          <p>
            <code>{item.commit.slice(0, 12)}</code> — {item.state}
          </p>
          {item.log && (
            <pre
              style={{
                whiteSpace: "pre-wrap",
                maxHeight: 160,
                overflow: "auto",
              }}
            >
              {item.log}
            </pre>
          )}
          {item.state !== "preparing" && item.state !== "pending" && (
            <button
              type="button"
              onClick={() => {
                void client
                  .post(
                    item.state === "cleanup-failed"
                      ? `/workspace-cleanup/${item.id}/retry`
                      : `/${reviewId}/workspaces/${item.id}/retry`,
                    {},
                  )
                  .catch((cause) => setError(String(cause)));
              }}
            >
              {item.state === "cleanup-failed"
                ? "Retry cleanup"
                : "Retry preparation"}
            </button>
          )}
        </div>
      ))}
    </details>
  );
}
