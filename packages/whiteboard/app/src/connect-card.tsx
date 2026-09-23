import {
  type WhiteboardCanvasInstallContent,
  type WhiteboardCliInstallStatus,
  type WhiteboardCliInstallTarget,
  WhiteboardCliInstallTargetSchema,
} from "@dev.fast/whiteboard-protocol";
import { useEffect, useRef, useState } from "react";

import { AGENT_LOGOS } from "./agent-logos";
import { CopyIcon, copyText } from "./copy-text";
import { newTabLinkProps } from "./link-props";

export const TARGET_LABELS: Record<WhiteboardCliInstallTarget, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  pi: "Pi",
};

export const WHITEBOARD_CONNECT_TARGET_STORAGE_KEY =
  "dev.fast.whiteboard.connectTarget";

const COPIED_RESET_MS = 2000;

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
}: {
  install: WhiteboardCanvasInstallContent;
}) {
  const { status } = install;

  const [target, setTarget] =
    useState<WhiteboardCliInstallTarget>(readStoredTarget);

  const [mode, setMode] = useState<Mode>("prompt");
  const [copied, setCopied] = useState(false);

  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const clearCopied = () => {
    setCopied(false);
    clearTimeout(resetTimer.current);
  };

  const selectTarget = (next: WhiteboardCliInstallTarget) => {
    setTarget(next);
    clearCopied();

    try {
      globalThis.localStorage?.setItem(WHITEBOARD_CONNECT_TARGET_STORAGE_KEY, next);
    } catch {
      // The desktop can disable DOM storage; the in-memory selection still works.
    }
  };

  const selectMode = (next: Mode) => {
    setMode(next);
    clearCopied();
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
    });
  };

  const noun = mode === "prompt" ? "prompt" : "install command";

  return (
    <section className="whiteboard-connect" aria-label="Connect your agents">
      {/* A packaged Desktop launches agents through the shim, so nothing
          works until it exists. From source the prompts use the bare
          command instead. */}
      {status.cli && !status.shim.installed ? (
        <p className="whiteboard-connect-note">
          Install the whiteboard command first. The prompt and the plugin both
          launch it.
        </p>
      ) : null}
      <div
        className="whiteboard-home-prompt-tabs whiteboard-connect-tabs"
        role="group"
        aria-label="Agent"
      >
        {WhiteboardCliInstallTargetSchema.options.map((tab) => {
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
        className="whiteboard-home-prompt-tabs whiteboard-connect-modes"
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
          <pre className="whiteboard-home-prompt-body">{text}</pre>
          <div className="whiteboard-home-prompt-actions">
            <button
              type="button"
              className="whiteboard-home-prompt-copy"
              aria-live="polite"
              aria-label={`${copied ? "Copied" : "Copy"} ${noun} for ${agent}`}
              onClick={() => copy(text)}
            >
              <CopyIcon />
              {copied
                ? "Copied"
                : `Copy ${mode === "prompt" ? "prompt" : "command"}`}
            </button>
          </div>
        </>
      ) : plugin.url ? (
        <>
          <p className="whiteboard-home-prompt-body">
            Opens {agent} and adds the review server.
          </p>
          <div className="whiteboard-home-prompt-actions">
            <a
              className="whiteboard-home-prompt-copy"
              href={plugin.url}
              {...newTabLinkProps(plugin.url)}
            >
              {plugin.label}
            </a>
          </div>
        </>
      ) : (
        <p className="whiteboard-home-prompt-body">
          {`${plugin.label}\nInstall the whiteboard command first.`}
        </p>
      )}
      {status.error ? (
        <p className="whiteboard-connect-error">{status.error}</p>
      ) : null}
    </section>
  );
}

function readStoredTarget(): WhiteboardCliInstallTarget {
  try {
    const stored = WhiteboardCliInstallTargetSchema.safeParse(
      globalThis.localStorage?.getItem(WHITEBOARD_CONNECT_TARGET_STORAGE_KEY),
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
  install: WhiteboardCanvasInstallContent;
  onStatusChange?: (status: WhiteboardCliInstallStatus) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [removal, setRemoval] = useState<{
    paths: string[];
    status: WhiteboardCliInstallStatus;
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
      className="whiteboard-connect-legacy"
      aria-label="Old Whiteboard skills"
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
            Remove old Whiteboard skills
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
      {error ? <p className="whiteboard-connect-error">{error}</p> : null}
    </section>
  );
}
