import { createContext, useContext, useEffect, useRef, useState } from "react";

import {
  type ReviewApiClient,
  ReviewApiError,
} from "../../src/review-api/client";

import "./share-control.css";
import { copyText } from "./copy-text";
import { ShareIcon } from "./icons";
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

type Account = {
  account: { login: string; origin: string } | null;
  pending: boolean;
  url?: string;
  error?: string;
};

export function ShareControl() {
  const context = useContext(SharingContext);
  const [open, setOpen] = useState(false);
  const [account, setAccount] = useState<Account>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [link, setLink] = useState<string>();
  const [copied, setCopied] = useState(false);

  const frozen = useRef<{
    version: number;
    requestId: string;
    started: boolean;
  }>(undefined);

  const popover = useRef<HTMLDivElement>(null);
  const popoverRef = useTopbarPopover(open, popover);
  const shared = context?.reviewId.startsWith("shared-");
  const signedIn = Boolean(account?.account);

  const label = shared
    ? `Shared${context?.sender ? ` by ${context.sender}` : " review"}`
    : "Share review";

  const tooltip = useTooltip(label);
  useEffect(() => {
    if (!open || !context || shared || signedIn) return;
    let cancelled = false;

    const load = () =>
      context.client
        .read<Account>("/sharing/account")
        .then((value) => {
          if (!cancelled) setAccount(value);
        })
        .catch(() => {
          if (!cancelled) setError("Could not read sign-in status.");
        });

    void load();

    const interval = setInterval(() => {
      void load();
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [open, context?.client, shared, signedIn]);
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

  const publish = () =>
    run(async () => {
      if (!context || !frozen.current) return;
      const { version, requestId } = frozen.current;

      const result = await context.client.post<{ url: string }>(
        "/sharing/publish",
        { reviewId: context.reviewId, version, requestId },
      );

      setLink(result.url);
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
    if (await copyText(url)) setCopied(true);
    else setError("Copy the link below.");
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
            frozen.current = {
              version: context.version,
              requestId: crypto.randomUUID(),
              started: false,
            };
            setAccount(undefined);
            setLink(undefined);
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
          style={{
            width: 320,
            padding: 16,
            zIndex: 100,
            background: "var(--vscode-editor-background, #202020)",
            color: "var(--vscode-editor-foreground, white)",
            border: "1px solid var(--vscode-widget-border, #555)",
            borderRadius: 6,
            boxShadow: "0 4px 16px #0006",
          }}
        >
          {shared ? (
            <>
              <p>{label}</p>
              <p>
                This is a read-only snapshot. Source files and traces are
                available offline.
              </p>
            </>
          ) : signedIn ? (
            link ? (
              <>
                <input
                  aria-label="Share link"
                  readOnly
                  value={link}
                  onFocus={(event) => event.target.select()}
                  style={{ width: "100%" }}
                />
                <button onClick={() => void copy(link)}>
                  {copied ? "Copied" : "Copy link"}
                </button>
              </>
            ) : error ? (
              <button onClick={() => void publish()}>Retry</button>
            ) : (
              <p>Uploading…</p>
            )
          ) : (
            account && (
              <>
                <p>Sign in to share</p>
                <button
                  disabled={account.pending || busy}
                  onClick={() =>
                    void run(async () => {
                      await context.client.post("/sharing/login", {});
                      setAccount({ account: null, pending: true });
                    })
                  }
                >
                  {account.pending ? "Waiting for GitHub…" : "Sign in"}
                </button>
                {account.pending && account.url && (
                  <p>
                    <a href={account.url} target="_blank" rel="noreferrer">
                      Open GitHub sign-in
                    </a>
                  </p>
                )}
              </>
            )
          )}
          {(error || account?.error) && (
            <p role="alert">{error ?? account?.error}</p>
          )}
        </div>
      )}
    </div>
  );
}
