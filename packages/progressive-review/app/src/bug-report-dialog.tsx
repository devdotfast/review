import { parseReviewBugReportResponse } from "@dev.fast/review-protocol";
import { type FormEvent, useEffect, useState } from "react";

import { useReviewSession } from "./host/review-session";
import { BugIcon } from "./icons";
import { captureUiEvent, clientErrorName } from "./ui-telemetry";

const MAX_DESCRIPTION_BYTES = 64 * 1024;

type Toast = { kind: "success" | "error"; text: string };

export function BugReportControl() {
  const session = useReviewSession();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [includeReview, setIncludeReview] = useState(true);
  const [includeMap, setIncludeMap] = useState(true);
  const [includeDiff, setIncludeDiff] = useState(true);
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const descriptionBytes = new TextEncoder().encode(description).byteLength;
  const canSend =
    description.trim().length > 0 &&
    descriptionBytes <= MAX_DESCRIPTION_BYTES &&
    !sending;

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 6_000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const reset = () => {
    setDescription("");
    setIncludeReview(true);
    setIncludeMap(true);
    setIncludeDiff(true);
    setSending(false);
  };
  const cancel = () => {
    captureUiEvent(session, "bug_report_cancelled");
    reset();
    setOpen(false);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSend) return;
    setSending(true);
    try {
      const response = await session.fetch("/telemetry/bug-report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          description,
          include_review: includeReview,
          include_map: includeMap,
          include_diff: includeDiff,
          app_session_id: session.appSessionId,
          app_version: session.config.appVersion,
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        captureUiEvent(session, "bug_report_send_failed", {
          error_name: clientErrorName(new Error()),
        });
        setToast({
          kind: "error",
          text:
            response.status === 429
              ? "Too many reports. Try again later."
              : response.status === 413
                ? "The report is too large. Remove an attachment and try again."
                : "The report could not be sent. Try again.",
        });
        return;
      }
      const result = parseReviewBugReportResponse(body);
      if (!result.ok) throw new Error(result.error);
      setToast({
        kind: "success",
        text: "Bug report was sent.",
      });
      reset();
      setOpen(false);
    } catch (error) {
      captureUiEvent(session, "bug_report_send_failed", {
        error_name: clientErrorName(error),
      });
      setToast({
        kind: "error",
        text: "The report could not be sent. Try again.",
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="topbar-report-bug-button"
        aria-label="Report a bug"
        title="Report a bug"
        onClick={() => {
          captureUiEvent(session, "bug_report_dialog_opened");
          setOpen(true);
        }}
      >
        <BugIcon />
      </button>
      {open && (
        <div className="bug-report-backdrop" onMouseDown={cancel}>
          <section
            className="bug-report-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bug-report-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <form onSubmit={submit}>
              <h2 id="bug-report-title">Report a bug</h2>
              <label className="bug-report-description">
                <span>What happened?</span>
                <textarea
                  autoFocus
                  required
                  rows={7}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Describe what you expected and what happened."
                />
              </label>
              <div
                className={
                  descriptionBytes > MAX_DESCRIPTION_BYTES
                    ? "bug-report-byte-count bug-report-byte-count--error"
                    : "bug-report-byte-count"
                }
              >
                {descriptionBytes.toLocaleString()} / 65,536 bytes
              </div>
              <fieldset>
                <legend>Include diagnostic attachments</legend>
                <label>
                  <input
                    type="checkbox"
                    checked={includeReview}
                    onChange={(event) => setIncludeReview(event.target.checked)}
                  />
                  Current review source
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={includeMap}
                    onChange={(event) => setIncludeMap(event.target.checked)}
                  />
                  Head software map source
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={includeDiff}
                    onChange={(event) => setIncludeDiff(event.target.checked)}
                  />
                  Changed-file diffs used by CodePeeks
                </label>
              </fieldset>
              <p className="bug-report-privacy">
                Reports are sent securely to dev.fast. Only authorized dev.fast
                team members can access them. Reports are deleted after 90 days.
              </p>
              <div className="bug-report-actions">
                <button type="button" onClick={cancel} disabled={sending}>
                  Cancel
                </button>
                <button type="submit" disabled={!canSend}>
                  {sending ? "Sending..." : "Send"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
      {toast && (
        <div
          className={`bug-report-toast bug-report-toast--${toast.kind}`}
          role="status"
        >
          {toast.text}
        </div>
      )}
    </>
  );
}
