import "./share-control.css";
import { createContext, useContext, useEffect, useRef, useState } from "react";

import {
  type ReviewApiClient,
  ReviewApiError,
} from "../../src/review-api/client";

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
  const [cloned, setCloned] = useState(false);
  const shared = context?.reviewId.startsWith("shared-");
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
  useEffect(() => {
    if (!open) return;

    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !popover.current?.contains(event.target)
      )
        setOpen(false);
    };

    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);

    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

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
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      setError("Copy the link below.");
    }
  };

  return (
    <div ref={popover} style={{ position: "relative" }}>
      <button
        type="button"
        className="review-share-button"
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
        {shared
          ? `Shared${context.sender ? ` by ${context.sender}` : " review"}`
          : "Share"}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={shared ? "Shared review" : "Share review"}
          style={{
            position: "absolute",
            right: 0,
            top: "100%",
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
              <p>
                This is a read-only snapshot. Source files and traces are
                available offline.
              </p>
              {context.cloneUrl && (
                <>
                  <p>Clone the repository for advanced features.</p>
                  <button
                    disabled={busy || cloned}
                    onClick={() =>
                      void run(async () => {
                        await context.client.post("/sharing/clone", {
                          reviewId: context.reviewId,
                        });
                        setCloned(true);
                      })
                    }
                  >
                    {busy
                      ? "Cloning…"
                      : cloned
                        ? "Attached — reopen code for advanced features"
                        : "Clone repository"}
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <p>
                Share version {frozen.current?.version}. Anyone with the link
                can download it, including full referenced source files and
                retained trace conversations.
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
