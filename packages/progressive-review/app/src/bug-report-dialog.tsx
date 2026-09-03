import {
  type ReviewBugReportRequest,
  parseReviewBugReportResponse,
} from "@dev.fast/review-protocol";
import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  ScreenshotTooLargeError,
  captureWindowScreenshot,
  imageFileFromDataTransfer,
  normalizeScreenshot,
} from "./bug-report-screenshot";
import { useReviewSession } from "./host/review-session";
import { BugIcon } from "./icons";
import { useTutorial } from "./tutorial-context";
import { captureUiEvent, clientErrorName } from "./ui-telemetry";

const MAX_DESCRIPTION_BYTES = 64 * 1024;
const TRACE_PRIVACY_COPY =
  "Includes the complete, uncapped authoring session trace. For forked sessions, it also includes each ancestor session up to its fork point, plus up to ten tail-capped subagent traces. Recognizable secrets are redacted, but other secrets may be included; everything is sent to /dev/fast.";

type Toast = { kind: "success" | "error"; text: string };

export function BugReportControl({
  captureScreenshot = captureWindowScreenshot,
}: {
  /** Captures the window when the dialog opens; tests inject a fake. */
  captureScreenshot?: typeof captureWindowScreenshot;
} = {}) {
  const session = useReviewSession();
  const tutorial = useTutorial();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [includeContext, setIncludeContext] = useState(true);
  const [includeDiff, setIncludeDiff] = useState(true);
  const [includeTrace, setIncludeTrace] = useState(false);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const tracePrivacyTooltipId = useId();
  const capturePending = useRef(false);
  const descriptionBytes = new TextEncoder().encode(description).byteLength;
  const canSend = descriptionBytes <= MAX_DESCRIPTION_BYTES && !sending;

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 6_000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const reset = () => {
    setDescription("");
    setIncludeContext(true);
    setIncludeDiff(true);
    setIncludeTrace(false);
    setScreenshot(null);
    setDropActive(false);
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
      const report: ReviewBugReportRequest = {
        description,
        include_review: includeContext,
        include_map: includeContext,
        include_diff: includeDiff,
        include_trace: includeTrace,
        app_session_id: session.appSessionId,
        app_version: session.config.appVersion,
      };
      if (screenshot) {
        report.screenshot = {
          mime: "image/jpeg",
          base64: screenshot.slice("data:image/jpeg;base64,".length),
        };
      }
      const response = await session.fetch("/telemetry/bug-report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(report),
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
                : response.status === 422
                  ? "The complete agent session trace couldn't be read. Uncheck 'Agent session trace' to send the report without it."
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

  const attachScreenshot = async (image: Blob) => {
    try {
      const normalized = await normalizeScreenshot(image);
      if (!normalized) throw new Error("Screenshot could not be decoded.");
      setScreenshot(normalized);
    } catch (error) {
      setToast({
        kind: "error",
        text:
          error instanceof ScreenshotTooLargeError
            ? "The screenshot is too large. Use an image under 3 MiB."
            : "That image could not be attached. Use a PNG, JPEG, or WebP image.",
      });
    }
  };

  const pasteScreenshot = (event: ClipboardEvent<HTMLElement>) => {
    const image = imageFileFromDataTransfer(event.clipboardData);
    if (!image) return;
    event.preventDefault();
    void attachScreenshot(image);
  };

  const dropScreenshot = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDropActive(false);
    const image = imageFileFromDataTransfer(event.dataTransfer);
    if (!image) {
      setToast({
        kind: "error",
        text: "That image could not be attached. Use a PNG, JPEG, or WebP image.",
      });
      return;
    }
    void attachScreenshot(image);
  };

  const openDialog = async () => {
    if (tutorial || capturePending.current) return;
    capturePending.current = true;
    setCapturing(true);
    captureUiEvent(session, "bug_report_dialog_opened");
    let captured: string | null = null;
    try {
      captured = await captureScreenshot(session.bridge);
    } finally {
      setScreenshot(captured);
      setOpen(true);
      setCapturing(false);
      capturePending.current = false;
    }
  };

  return (
    <>
      <button
        type="button"
        className="topbar-report-bug-button"
        aria-label="Report a bug"
        title="Report a bug"
        disabled={tutorial !== null || capturing}
        onClick={() => void openDialog()}
      >
        <BugIcon />
      </button>
      {open && (
        <div className="bug-report-backdrop" onMouseDown={cancel}>
          <section
            className={
              dropActive
                ? "bug-report-dialog bug-report-dialog--drop-target"
                : "bug-report-dialog"
            }
            role="dialog"
            aria-modal="true"
            aria-labelledby="bug-report-title"
            onMouseDown={(event) => event.stopPropagation()}
            onPaste={pasteScreenshot}
            onDragOver={(event) => {
              event.preventDefault();
              setDropActive(true);
            }}
            onDragLeave={(event) => {
              const next = event.relatedTarget;
              if (next instanceof Node && event.currentTarget.contains(next)) {
                return;
              }
              setDropActive(false);
            }}
            onDrop={dropScreenshot}
          >
            <form onSubmit={submit}>
              <h2 id="bug-report-title">Report a bug</h2>
              <label className="bug-report-description">
                <span>What happened? (optional)</span>
                <textarea
                  autoFocus
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
                    checked={includeContext}
                    onChange={(event) =>
                      setIncludeContext(event.target.checked)
                    }
                  />
                  Review
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={includeDiff}
                    onChange={(event) => setIncludeDiff(event.target.checked)}
                  />
                  Changed-file diffs used by CodePeeks
                </label>
                <div className="bug-report-option">
                  <label>
                    <input
                      type="checkbox"
                      checked={includeTrace}
                      onChange={(event) =>
                        setIncludeTrace(event.target.checked)
                      }
                    />
                    Agent session trace
                  </label>
                  <span className="bug-report-trace-info">
                    <button
                      type="button"
                      aria-label="Agent session trace privacy information"
                      aria-describedby={tracePrivacyTooltipId}
                    >
                      i
                    </button>
                    <span
                      id={tracePrivacyTooltipId}
                      role="tooltip"
                      className="bug-report-trace-tooltip"
                    >
                      {TRACE_PRIVACY_COPY}
                    </span>
                  </span>
                </div>
                <div className="bug-report-screenshot">
                  {screenshot ? (
                    <>
                      <img src={screenshot} alt="Screenshot preview" />
                      <button
                        type="button"
                        className="bug-report-screenshot-remove"
                        aria-label="Remove screenshot"
                        title="Remove screenshot"
                        onClick={() => setScreenshot(null)}
                      >
                        ×
                      </button>
                    </>
                  ) : (
                    <span className="bug-report-screenshot-hint">
                      Paste or drop an image to attach a screenshot.
                    </span>
                  )}
                </div>
              </fieldset>
              <p className="bug-report-privacy">
                Reports are sent securely to /dev/fast. Only authorized
                /dev/fast team members can access them. Reports are deleted
                after 90 days. The screenshot above is included unless you
                remove it.
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
