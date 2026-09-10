import {
  HOST_SOURCE_FILE_BYTES,
  type HostDocumentState,
  type HostQueryInputs,
  type HostQueryResults,
  type ReviewClient,
  type ReviewHostSourceBridge,
} from "@dev.fast/review-protocol";
import { useEffect, useRef, useState } from "react";

import "./host-source-browser.css";

type SourcePage =
  | { kind: "tree"; data: HostQueryResults["source.tree"] }
  | { kind: "commits"; data: HostQueryResults["source.commits"] }
  | { kind: "diff"; data: HostQueryResults["source.diff"] };

/** Pinned source exploration uses the same API in native and portable viewers. */
export function HostSourceBrowser({
  client,
  document,
  source,
}: {
  client: ReviewClient;
  document: HostDocumentState;
  source?: ReviewHostSourceBridge;
}) {
  const [mode, setMode] = useState<SourcePage["kind"]>("tree");
  const [side, setSide] = useState<"base" | "head">("head");
  const [directory, setDirectory] = useState("");
  const [pagination, setPagination] = useState<{
    client: ReviewClient;
    reviewId: string;
    documentVersion: number;
    cursor: string;
  }>();
  // A cursor belongs to the exact observed document, not just this source view.
  const cursor =
    pagination?.client === client &&
    pagination.reviewId === document.reviewId &&
    pagination.documentVersion === document.version
      ? pagination.cursor
      : undefined;
  const setCursor = (value: string | undefined) =>
    setPagination(
      value
        ? {
            client,
            reviewId: document.reviewId,
            documentVersion: document.version,
            cursor: value,
          }
        : undefined,
    );
  const [page, setPage] = useState<SourcePage>();
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<{
    file: string;
    side: "base" | "head";
    text: string;
  }>();
  const [opening, setOpening] = useState<string>();
  const [retry, setRetry] = useState(0);
  const fileGeneration = useRef(0);
  useEffect(() => {
    fileGeneration.current++;
    setPagination(undefined);
    setPreview(undefined);
    setOpening(undefined);
    return () => {
      fileGeneration.current++;
    };
  }, [client, document.reviewId, document.version]);
  useEffect(() => {
    const abort = new AbortController();
    setPage(undefined);
    setError(undefined);
    const input: HostQueryInputs["source.commits"] = {
      reviewId: document.reviewId,
      documentVersion: document.version,
      limit: 100,
    };
    if (cursor) input.cursor = cursor;
    const fetchPage = async (): Promise<SourcePage> => {
      if (mode === "tree") {
        const treeInput: HostQueryInputs["source.tree"] = { ...input, side };
        if (directory) treeInput.directory = directory;
        return {
          kind: mode,
          data: (await client.query("source.tree", treeInput, abort.signal))
            .result,
        };
      }
      if (mode === "commits")
        return {
          kind: mode,
          data: (await client.query("source.commits", input, abort.signal))
            .result,
        };
      return {
        kind: mode,
        data: (await client.query("source.diff", input, abort.signal)).result,
      };
    };
    void fetchPage().then(
      (value) => {
        if (!abort.signal.aborted) setPage(value);
      },
      (cause: unknown) => {
        if (!abort.signal.aborted) setError(sourceMessage(cause));
      },
    );
    return () => abort.abort();
  }, [
    client,
    document.reviewId,
    document.version,
    mode,
    side,
    directory,
    cursor,
    retry,
  ]);

  const navigate = (kind: SourcePage["kind"]) => {
    setMode(kind);
    setCursor(undefined);
    setPreview(undefined);
  };
  const open = async (file: string, selectedSide: "base" | "head") => {
    const generation = ++fileGeneration.current;
    setOpening(file);
    setError(undefined);
    try {
      if (source)
        await source.open({
          reviewId: document.reviewId,
          documentVersion: document.version,
          range: { side: selectedSide, file, fromLine: 1, toLine: 1 },
        });
      else {
        const result = await client.query("source.file", {
          reviewId: document.reviewId,
          documentVersion: document.version,
          side: selectedSide,
          file,
        });
        if (generation === fileGeneration.current)
          setPreview({ file, side: selectedSide, text: result.result.text });
      }
    } catch (cause) {
      if (generation === fileGeneration.current) setError(sourceMessage(cause));
    } finally {
      if (generation === fileGeneration.current) setOpening(undefined);
    }
  };
  return (
    <section className="host-source-browser" aria-label="Pinned source">
      <header>
        <h2>Pinned source</h2>
        <span>Document version {document.version}</span>
        <nav aria-label="Source views">
          <button
            type="button"
            aria-pressed={mode === "tree"}
            onClick={() => navigate("tree")}
          >
            Files
          </button>
          <button
            type="button"
            aria-pressed={mode === "diff"}
            onClick={() => navigate("diff")}
          >
            Changes
          </button>
          <button
            type="button"
            aria-pressed={mode === "commits"}
            onClick={() => navigate("commits")}
          >
            Commits
          </button>
        </nav>
      </header>
      {mode === "tree" && (
        <div className="host-source-location">
          <label>
            Revision{" "}
            <select
              aria-label="Source revision"
              value={side}
              onChange={(event) => {
                setSide(event.target.value === "base" ? "base" : "head");
                setDirectory("");
                setCursor(undefined);
              }}
            >
              <option value="head">
                Head · {document.binding.headCommit.slice(0, 8)}
              </option>
              <option value="base">
                Base · {document.binding.baseCommit.slice(0, 8)}
              </option>
            </select>
          </label>
          <button
            type="button"
            disabled={!directory}
            onClick={() => {
              setDirectory("");
              setCursor(undefined);
            }}
          >
            Repository root
          </button>
          {directory && (
            <>
              <span>{directory}</span>
              <button
                type="button"
                onClick={() => {
                  setDirectory(directory.split("/").slice(0, -1).join("/"));
                  setCursor(undefined);
                }}
              >
                Parent directory
              </button>
            </>
          )}
        </div>
      )}
      {error && (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Retry source read
          </button>
        </p>
      )}
      {!page && !error && <p role="status">Reading pinned source…</p>}
      {page?.kind === "tree" && (
        <ul className="host-source-files">
          {page.data.items.map((entry) => (
            <li key={entry.path}>
              {entry.kind === "directory" ? (
                <button
                  type="button"
                  onClick={() => {
                    setDirectory(entry.path);
                    setCursor(undefined);
                  }}
                >
                  {entry.path.split("/").at(-1)}/
                </button>
              ) : entry.kind === "file" ? (
                <button
                  type="button"
                  disabled={
                    !!opening ||
                    (entry.byteLength ?? 0) > HOST_SOURCE_FILE_BYTES
                  }
                  onClick={() => void open(entry.path, side)}
                >
                  {entry.path.split("/").at(-1)}
                </button>
              ) : (
                <span>
                  {entry.path.split("/").at(-1)} · {entry.kind} (not followed)
                </span>
              )}
              {entry.byteLength !== undefined && (
                <small>
                  {entry.byteLength.toLocaleString()} bytes
                  {entry.byteLength > HOST_SOURCE_FILE_BYTES
                    ? " · too large to view"
                    : ""}
                </small>
              )}
            </li>
          ))}
        </ul>
      )}
      {page?.kind === "diff" && (
        <ul className="host-source-files">
          {page.data.items.map((file) => (
            <li key={file.path}>
              <span>
                {file.previousPath ? `${file.previousPath} → ` : ""}
                {file.path} · {file.status}
              </span>
              <small>
                {file.binary
                  ? "Binary"
                  : `+${file.additions} −${file.deletions}`}
              </small>
              {file.status !== "added" && (
                <button
                  type="button"
                  disabled={!!opening || file.binary}
                  onClick={() =>
                    void open(file.previousPath ?? file.path, "base")
                  }
                >
                  Base
                </button>
              )}
              {file.status !== "deleted" && (
                <button
                  type="button"
                  disabled={!!opening || file.binary}
                  onClick={() => void open(file.path, "head")}
                >
                  Head
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {page?.kind === "commits" && (
        <ol className="host-source-commits">
          {page.data.items.map((commit) => (
            <li key={commit.oid}>
              <code>{commit.oid.slice(0, 12)}</code> {commit.subject}
              <small>
                {commit.author} · {new Date(commit.at).toLocaleString()}
              </small>
            </li>
          ))}
        </ol>
      )}
      {page?.data.items.length === 0 && (
        <p>
          No{" "}
          {mode === "diff"
            ? "changed files"
            : mode === "commits"
              ? "commits between these pins"
              : "files in this directory"}
          .
        </p>
      )}
      {page && (
        <footer>
          {cursor && (
            <button type="button" onClick={() => setCursor(undefined)}>
              First page
            </button>
          )}
          {page.data.nextCursor && (
            <button
              type="button"
              onClick={() => setCursor(page.data.nextCursor ?? undefined)}
            >
              Next page
            </button>
          )}
        </footer>
      )}
      {opening && <p role="status">Opening {opening}…</p>}
      {preview && (
        <section aria-label="Source preview">
          <header>
            <h3>
              {preview.file} · {preview.side}
            </h3>
            <button type="button" onClick={() => setPreview(undefined)}>
              Close source preview
            </button>
          </header>
          <pre tabIndex={0}>
            <code>{preview.text}</code>
          </pre>
        </section>
      )}
    </section>
  );
}

function sourceMessage(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "Pinned source is unavailable. Retained evidence in the document is still viewable.";
}
