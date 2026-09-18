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
  const frozen = useRef<{ version: number; requestId: string }>(undefined);
  const popover = useRef<HTMLDivElement>(null);
  const popoverRef = useTopbarPopover(open, popover);
  const shared = context?.reviewId.startsWith("shared-");

  const label = shared
    ? `Shared${context?.sender ? ` by ${context.sender}` : " review"}`
    : "Share review";

  const tooltip = useTooltip(label);
  useEffect(() => {
    if (!open || !context || shared) return;
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
  }, [open, context?.client, shared]);
  useDismissOnOutside(popover, open, setOpen);

  if (!context) return null;

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

  const copy = async (url: string) => {
    if (!(await copyText(url))) setError("Copy the link below.");
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
            };
            setLink(undefined);
            setError(undefined);
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
          ) : (
            <>
              <p>
                Share version {frozen.current?.version}. Anyone with the link
                can download its retained resources and trace conversations.
                Recipients need GitHub repository access to fetch the pinned
                commits.
              </p>
              {account?.account ? (
                <>
                  <p>Signed in as {account.account.login}</p>
                  <button
                    disabled={busy || Boolean(link)}
                    onClick={() =>
                      void run(async () => {
                        const result = await context.client.post<{
                          url: string;
                        }>("/sharing/publish", {
                          reviewId: context.reviewId,
                          ...frozen.current,
                        });

                        setLink(result.url);
                        await copy(result.url);
                      })
                    }
                  >
                    {busy
                      ? "Uploading…"
                      : link
                        ? "Link ready"
                        : "Create share link"}
                  </button>
                </>
              ) : (
                <button
                  disabled={account?.pending || busy}
                  onClick={() =>
                    void run(async () => {
                      await context.client.post("/sharing/login", {});
                      setAccount({ account: null, pending: true });
                    })
                  }
                >
                  {account?.pending
                    ? "Waiting for GitHub…"
                    : "Sign in with GitHub"}
                </button>
              )}
              {account?.pending && account.url && (
                <p>
                  <a href={account.url} target="_blank" rel="noreferrer">
                    Open GitHub sign-in
                  </a>
                </p>
              )}
              {link && (
                <>
                  <input
                    aria-label="Share link"
                    readOnly
                    value={link}
                    onFocus={(event) => event.target.select()}
                    style={{ width: "100%", marginTop: 12 }}
                  />
                  <button onClick={() => void copy(link)}>Copy link</button>
                </>
              )}
            </>
          )}
          {(error || account?.error) && (
            <p role="alert">{error ?? account?.error}</p>
          )}
          <button onClick={() => setOpen(false)}>Close</button>
        </div>
      )}
    </div>
  );
}
