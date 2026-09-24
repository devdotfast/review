import {
  type ReviewCanvasInstallContent,
  type ReviewCliInstallStatus,
  type ReviewCliInstallTarget,
  ReviewCliInstallTargetSchema,
} from "@dev.fast/review-protocol";
import { useEffect, useRef, useState } from "react";

import { AGENT_LOGOS } from "./agent-logos";
import { cliInstallReady } from "./cli-install-status";
import { CopyIcon, copyText } from "./copy-text";
import { newTabLinkProps } from "./link-props";

export const TARGET_LABELS: Record<ReviewCliInstallTarget, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  pi: "Pi",
};

export const REVIEW_CONNECT_TARGET_STORAGE_KEY =
  "dev.fast.review.connectTarget";

const COPIED_RESET_MS = 2000;

/** Lines of a prompt shown before the reader expands it. */
const COLLAPSED_LINES = 4;

type Mode = "prompt" | "plugin";

const MODES: ReadonlyArray<{ mode: Mode; label: string }> = [
  { mode: "prompt", label: "Paste a prompt" },
  { mode: "plugin", label: "Install the plugin" },
];

/**
 * One agent at a time: a paste-in prompt that has the agent add Whiteboard's MCP
 * server, or the published plugin (an install command, or Cursor's link).
 */
export function ConnectCard({
  install,
  onCopied,
}: {
  install: ReviewCanvasInstallContent;
  onCopied?: () => void;
}) {
  const { status } = install;

  const [target, setTarget] =
    useState<ReviewCliInstallTarget>(readStoredTarget);

  const [mode, setMode] = useState<Mode>("prompt");
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const clearCopied = () => {
    setCopied(false);
    clearTimeout(resetTimer.current);
  };

  const selectTarget = (next: ReviewCliInstallTarget) => {
    setTarget(next);
    clearCopied();
    setExpanded(false);

    try {
      globalThis.localStorage?.setItem(REVIEW_CONNECT_TARGET_STORAGE_KEY, next);
    } catch {
      // The desktop can disable DOM storage; the in-memory selection still works.
    }
  };

  const selectMode = (next: Mode) => {
    setMode(next);
    clearCopied();
    setExpanded(false);
  };

  const agent = TARGET_LABELS[target];

  const plugin = status.connect.plugins[target];

  const text =
    mode === "prompt" ? status.connect.prompts[target] : plugin.command;

  const copy = (value: string) => {
    void copyText(value).then((ok) => {
      if (!ok) {
        return;
      }

      setCopied(true);
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
      onCopied?.();
    });
  };

  const noun = mode === "prompt" ? "prompt" : "install command";

  // Prompts run to a dozen lines; show the opening and let the reader expand.
  const collapsible = (text?.split("\n").length ?? 0) > COLLAPSED_LINES;

  const collapsed = collapsible && !expanded;

  if (status.legacySkills.length > 0 || !cliInstallReady(status)) {
    return (
      <section className="review-connect" aria-label="Connect your agents">
        <p className="review-connect-note">
          {status.legacySkills.length > 0
            ? "Remove deprecated skills first."
            : "Install the whiteboard command in PATH first."}
        </p>
      </section>
    );
  }

  return (
    <section className="review-connect" aria-label="Connect your agents">
      <div
        className="review-home-prompt-tabs review-connect-tabs"
        role="group"
        aria-label="Agent"
      >
        {ReviewCliInstallTargetSchema.options.map((tab) => {
          const Logo = AGENT_LOGOS[tab];

          return (
            <button
              key={tab}
              type="button"
              className={target === tab ? "is-active" : undefined}
              aria-pressed={target === tab}
              onClick={() => selectTarget(tab)}
            >
              <Logo />
              {TARGET_LABELS[tab]}
            </button>
          );
        })}
      </div>
      <div
        className="review-home-prompt-tabs review-connect-modes"
        role="group"
        aria-label="Setup method"
      >
        {MODES.map(({ mode: tab, label }) => (
          <button
            key={tab}
            type="button"
            className={mode === tab ? "is-active" : undefined}
            aria-pressed={mode === tab}
            onClick={() => selectMode(tab)}
          >
            {label}
          </button>
        ))}
      </div>
      {text ? (
        <>
          <div className="review-connect-body-wrap">
            <pre
              className="review-home-prompt-body review-connect-body"
              data-collapsed={collapsed}
            >
              {text.split(/(--[a-z][a-z-]*)/g).map((part, index) =>
                part.startsWith("--") ? (
                  <span className="review-connect-option" key={index}>
                    {part}
                  </span>
                ) : (
                  part
                ),
              )}
            </pre>
            {collapsed ? (
              <button
                type="button"
                className="review-connect-expand"
                aria-expanded={false}
                onClick={() => setExpanded(true)}
              >
                Show full {noun}
              </button>
            ) : null}
          </div>
          <div className="review-home-prompt-actions">
            {collapsible && expanded ? (
              <button
                type="button"
                className="review-connect-collapse"
                aria-expanded={true}
                onClick={() => setExpanded(false)}
              >
                Show less
              </button>
            ) : null}
            <button
              type="button"
              className="review-home-prompt-copy"
              aria-live="polite"
              aria-label={`${copied ? "Copied" : "Copy"} ${noun} for ${agent}`}
              onClick={() => copy(text)}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
              {copied
                ? "Copied"
                : `Copy ${mode === "prompt" ? "prompt" : "command"}`}
            </button>
          </div>
        </>
      ) : plugin.url ? (
        <>
          <p className="review-home-prompt-body">
            Opens {agent} and adds the review server.
          </p>
          <div className="review-home-prompt-actions">
            <a
              className="review-home-prompt-copy"
              href={plugin.url}
              {...newTabLinkProps(plugin.url)}
            >
              {plugin.label}
            </a>
          </div>
        </>
      ) : (
        <p className="review-home-prompt-body">
          {`${plugin.label}\nInstall the whiteboard command first.`}
        </p>
      )}
      {status.error ? (
        <p className="review-connect-error">{status.error}</p>
      ) : null}
    </section>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2.5 6.5 5 9l4.5-6" fill="none" />
    </svg>
  );
}

function readStoredTarget(): ReviewCliInstallTarget {
  try {
    const stored = ReviewCliInstallTargetSchema.safeParse(
      globalThis.localStorage?.getItem(REVIEW_CONNECT_TARGET_STORAGE_KEY),
    );

    if (stored.success) {
      return stored.data;
    }
  } catch {
    // Fall through to the default when DOM storage is unavailable.
  }

  return "claude";
}

/**
 * Skills that earlier versions of Whiteboard installed into agent configs. After
 * a removal the row names what went, until the next status refresh.
 */
export function LegacySkillsRow({
  install,
  onStatusChange,
}: {
  install: ReviewCanvasInstallContent;
  onStatusChange?: (status: ReviewCliInstallStatus) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [removal, setRemoval] = useState<{
    paths: string[];
    status: ReviewCliInstallStatus;
  } | null>(null);

  const { legacySkills } = install.status;

  const removed = removal?.status === install.status ? removal.paths : [];

  if (legacySkills.length === 0 && removed.length === 0) return null;

  const removeSkills = async () => {
    setBusy(true);
    setError(null);

    try {
      const next = await install.removeLegacySkills();

      const remaining = new Set(next.legacySkills.map((skill) => skill.path));

      const paths = legacySkills
        .map((skill) => skill.path)
        .filter((path) => !remaining.has(path));

      setRemoval({ paths, status: next });
      onStatusChange?.(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="review-connect-legacy"
      aria-label="Deprecated Whiteboard skills"
    >
      {legacySkills.length > 0 ? (
        <>
          <p>
            Earlier versions of Whiteboard installed these skills. Whiteboard no
            longer uses them.
          </p>
          <ul>
            {legacySkills.map((skill) => (
              <li key={skill.path}>
                <code>{skill.path}</code>
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={busy}
            onClick={() => void removeSkills()}
          >
            Remove deprecated skills
          </button>
        </>
      ) : null}
      {removed.length > 0 ? (
        <>
          <p>
            Removed {removed.length} skill{removed.length === 1 ? "" : "s"}
          </p>
          <ul>
            {removed.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {error ? <p className="review-connect-error">{error}</p> : null}
    </section>
  );
}
