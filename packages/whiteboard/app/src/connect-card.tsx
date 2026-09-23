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

const COPIED_RESET_MS = 2000;

type CopyKind = "command" | "prompt";

/**
 * Per agent, the published plugin (an install command, or Cursor's link) and,
 * below it, a paste-in prompt that has the agent add Whiteboard's MCP server.
 */
export function ConnectCard({
  install,
}: {
  install: WhiteboardCanvasInstallContent;
}) {
  const { status } = install;

  // A packaged Desktop launches agents through the shim, so nothing works
  // until it exists. From source the prompts use the bare command instead.
  const blocked = Boolean(status.cli) && !status.shim.installed;

  const [copied, setCopied] = useState<{
    kind: CopyKind;
    target: WhiteboardCliInstallTarget;
  } | null>(null);

  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const copy = (
    kind: CopyKind,
    target: WhiteboardCliInstallTarget,
    text: string,
  ) => {
    void copyText(text).then((ok) => {
      if (!ok) {
        return;
      }

      setCopied({ kind, target });
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(null), COPIED_RESET_MS);
    });
  };

  const isCopied = (kind: CopyKind, target: WhiteboardCliInstallTarget) =>
    copied?.kind === kind && copied.target === target;

  return (
    <section className="whiteboard-connect" aria-label="Connect your agents">
      {blocked ? (
        <p className="whiteboard-connect-note">
          Install the whiteboard command first.
        </p>
      ) : null}
      <ul className="whiteboard-connect-agents">
        {WhiteboardCliInstallTargetSchema.options.map((target) => {
          const Logo = AGENT_LOGOS[target];

          const agent = TARGET_LABELS[target];

          const plugin = status.connect.plugins[target];

          const { command } = plugin;

          return (
            <li key={target}>
              <span className="whiteboard-connect-logo-slot">
                <Logo />
              </span>
              <span className="whiteboard-connect-name">{agent}</span>
              <div className="whiteboard-connect-plugin">
                {plugin.url && !blocked ? (
                  <a href={plugin.url} {...newTabLinkProps(plugin.url)}>
                    {plugin.label}
                  </a>
                ) : (
                  <span>{plugin.label}</span>
                )}
                {command ? (
                  <>
                    <pre>{command}</pre>
                    <button
                      type="button"
                      className="whiteboard-connect-copy"
                      disabled={blocked}
                      aria-live="polite"
                      aria-label={`${isCopied("command", target) ? "Copied" : "Copy"} install command for ${agent}`}
                      onClick={() => copy("command", target, command)}
                    >
                      <CopyIcon />
                      {isCopied("command", target) ? "Copied" : "Copy command"}
                    </button>
                  </>
                ) : null}
              </div>
              <span className="whiteboard-connect-or">
                or paste this prompt
              </span>
              <button
                type="button"
                className="whiteboard-connect-copy"
                disabled={blocked}
                aria-live="polite"
                aria-label={`${isCopied("prompt", target) ? "Copied" : "Copy"} prompt for ${agent}`}
                onClick={() =>
                  copy("prompt", target, status.connect.prompts[target])
                }
              >
                <CopyIcon />
                {isCopied("prompt", target) ? "Copied" : "Copy prompt"}
              </button>
              <details className="whiteboard-connect-prompt">
                <summary>Show prompt</summary>
                <pre>{status.connect.prompts[target]}</pre>
              </details>
            </li>
          );
        })}
      </ul>
      {status.error ? (
        <p className="whiteboard-connect-error">{status.error}</p>
      ) : null}
    </section>
  );
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
