import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  type ReviewApiClient,
  ReviewApiError,
} from "../../src/review-api/client";

import "./share-control.css";
import { copyText } from "./copy-text";
import { useOptionalReviewSession } from "./host/review-session";
import { ShareIcon } from "./icons";
import { captureUiEvent } from "./ui-telemetry";
import { useDismissOnOutside } from "./use-dismiss-on-outside";
import { useTooltip } from "./use-tooltip";
import { useTopbarPopover } from "./use-topbar-popover";

export const SharingContext = createContext<{
  client: ReviewApiClient;
  reviewId: string;
  version: number;
  sender?: string;
  cloneUrl?: string;
} | null>(null);

interface SharingAccount {
  account: { login: string; origin: string } | null;
  pending: boolean;
  error?: string;
}

const POLL_WHILE_PENDING_MS = 2000;

const linkKey = (reviewId: string, version: number) => `${reviewId}@${version}`;

export function ShareControl() {
  const context = useContext(SharingContext);
  const session = useOptionalReviewSession();
  const client = context?.client;
  const [open, setOpen] = useState(false);
  // Read once while the review is open, refreshed on focus, polled while pending.
  const [account, setAccount] = useState<SharingAccount>();
  const [accountError, setAccountError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [link, setLink] = useState<string>();
  const [copied, setCopied] = useState(false);
  // Links created this session, so reopening a shared version skips the upload.
  const links = useRef(new Map<string, string>());

  const frozen = useRef<{
    version: number;
    requestId: string;
    started: boolean;
  }>(undefined);

  const popover = useRef<HTMLDivElement>(null);
  const popoverRef = useTopbarPopover(open, popover);
  const shared = context?.reviewId.startsWith("shared-");
  const signedIn = Boolean(account?.account);
  const pending = Boolean(account?.pending);

  const label = shared
    ? `Shared${context?.sender ? ` by ${context.sender}` : " review"}`
    : "Share review";

  const tooltip = useTooltip(label);

  const loadAccount = useCallback(async () => {
    if (!client) return;

    try {
      setAccount(await client.read<SharingAccount>("/sharing/account"));
      setAccountError(undefined);
    } catch {
      setAccountError("Could not read sign-in status.");
    }
  }, [client]);

  useEffect(() => {
    if (!client || shared) return;
    const load = () => void loadAccount();

    load();
    window.addEventListener("focus", load);

    return () => window.removeEventListener("focus", load);
  }, [client, shared, loadAccount]);

  useEffect(() => {
    if (!pending) return;

    const interval = setInterval(
      () => void loadAccount(),
      POLL_WHILE_PENDING_MS,
    );

    return () => clearInterval(interval);
  }, [pending, loadAccount]);
  useDismissOnOutside(popover, open, setOpen);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);

    try {
      await operation();
    } catch (error) {
      setError(
        error instanceof ReviewApiError && error.status < 500
          ? error.message
          : "Could not complete this action. Please retry.",
      );
    } finally {
      setBusy(false);
    }
  };

  const login = async () => {
    if (!client) return;
    await client.post("/sharing/login", {});
    setAccount({ account: null, pending: true });
  };

  const publish = () =>
    run(async () => {
      if (!context || !frozen.current) return;
      const { version, requestId } = frozen.current;

      try {
        const result = await context.client.post<{ url: string }>(
          "/sharing/publish",
          { reviewId: context.reviewId, version, requestId },
        );

        links.current.set(linkKey(context.reviewId, version), result.url);
        setLink(result.url);
      } catch (error) {
        if (error instanceof ReviewApiError && error.status === 422)
          frozen.current.requestId = crypto.randomUUID();

        // The host forgot a stale login; show sign-in and upload again after it.
        if (error instanceof ReviewApiError && error.status === 401) {
          frozen.current.started = false;
          void loadAccount();
        }

        throw error;
      }
    });

  useEffect(() => {
    if (!open || !signedIn || !frozen.current || frozen.current.started) return;
    frozen.current.started = true;
    void publish();
  }, [open, signedIn]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);

    return () => clearTimeout(timer);
  }, [copied]);

  if (!context) return null;

  const copy = async (url: string) => {
    if (!(await copyText(url))) {
      setError("Copy the link below.");

      return;
    }

    setCopied(true);

    if (session) captureUiEvent(session, "review_shared");
  };

  return (
    <div ref={popover} style={{ position: "relative" }}>
      <button
        type="button"
        className="review-topbar-icon-button review-share-button"
        ref={tooltip}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (!open) {
            // A version shared earlier this session reuses its link.
            const cached = links.current.get(
              linkKey(context.reviewId, context.version),
            );

            frozen.current = {
              version: context.version,
              requestId: crypto.randomUUID(),
              started: cached !== undefined,
            };
            setLink(cached);
            setError(undefined);
            setCopied(false);
          }

          setOpen(!open);
        }}
      >
        <ShareIcon />
      </button>
      {open && (
        <div
          ref={popoverRef}
          popover="manual"
          role="dialog"
          aria-label={shared ? "Shared review" : "Share review"}
          className="review-share-popover"
        >
          {(error || accountError || account?.error) && (
            <p className="review-share-error" role="alert">
              {error ?? accountError ?? account?.error}
            </p>
          )}
          {shared ? (
            <>
              <p className="review-share-status">{label}</p>
              <p className="review-share-status">
                This is a read-only snapshot. Source files and traces are
                available offline.
              </p>
            </>
          ) : signedIn ? (
            link ? (
              <>
                <input
                  className="review-share-link"
                  aria-label="Share link"
                  readOnly
                  value={link}
                  onFocus={(event) => event.target.select()}
                />
                <button
                  type="button"
                  className="review-share-action"
                  onClick={() => void copy(link)}
                >
                  {copied ? "Copied" : "Copy link"}
                </button>
              </>
            ) : error ? (
              <button
                type="button"
                className="review-share-action"
                onClick={() => void publish()}
              >
                Retry
              </button>
            ) : (
              <p className="review-share-status">Uploading…</p>
            )
          ) : (
            account && (
              <>
                <button
                  type="button"
                  className="review-share-action"
                  disabled={account.pending || busy}
                  onClick={() => void run(login)}
                >
                  {account.pending
                    ? "Waiting for sign-in…"
                    : "Sign in to share"}
                </button>
              </>
            )
          )}
        </div>
      )}
    </div>
  );
}
