import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { z } from "zod";

import type { CodexSelection } from "../../src/codex-selection";
import { useReviewSession } from "./host/review-session";
import { buildCodeTarget } from "./target-fingerprint";
import { useResolvedBaseRef, useResolvedHeadRef } from "./thread-target-model";

type Select = (selection: Omit<CodexSelection, "revision"> | null) => void;

const SelectionContext = createContext<Select>(() => {});

export function useCodexSelection() {
  return useContext(SelectionContext);
}

/** Selection survives window blur; only explicit clear/navigation removes it. */
export function CodexSelectionProvider({
  revision,
  children,
}: {
  revision: string;
  children: ReactNode;
}) {
  const session = useReviewSession();
  const instanceId = useId();
  const base = useResolvedBaseRef();
  const head = useResolvedHeadRef();
  const [enabled, setEnabled] = useState(false);
  const [selection, setSelection] = useState<CodexSelection | null>(null);
  const [status, setStatus] = useState("");
  const [context, setContext] = useState<string | null>(null);
  const sequence = useRef(0);
  const queue = useRef(Promise.resolve());

  const select = useCallback<Select>(
    (value) => {
      sequence.current++;
      setContext(null);
      setSelection(
        value
          ? { ...value, detail: value.detail?.slice(0, 24000), revision }
          : null,
      );
    },
    [revision],
  );

  useEffect(() => {
    select(null);
  }, [select]);
  useEffect(
    () =>
      session.surface.subscribe((event) => {
        if (
          event.event !== "editorSelectionChanged" ||
          event.isEmpty === undefined ||
          !event.sideContext ||
          !base ||
          !head
        )
          return;
        select({
          target: buildCodeTarget({
            path: event.path,
            side: event.sideContext,
            baseCommit: base,
            headCommit: head,
            span: {
              startLine: event.range.fromLine,
              endLine: event.range.toLine,
            },
          }),
          fileOnly: event.isEmpty,
          selectedDiff: event.selectedDiff,
          title: event.isEmpty
            ? event.path
            : `${event.path}:${event.range.fromLine}–${event.range.toLine}`,
        });
      }),
    [session, base, head, select],
  );

  const live = useRef({ enabled, selection, sequence: sequence.current });
  live.current = { enabled, selection, sequence: sequence.current };
  const mounted = useRef(true);

  const publish = useCallback(
    (clear = false) => {
      const current = live.current;

      const body = JSON.stringify({
        clientId: `${session.appSessionId}:${instanceId}`,
        sequence: current.sequence,
        selection: !clear && current.enabled ? current.selection : null,
      });

      queue.current = queue.current
        .catch(() => {})
        .then(async () => {
          const response = await session.fetch("/ide-context", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          });

          if (!response.ok) throw new Error("Could not publish selection");

          const result = z
            .object({ connected: z.boolean(), context: z.string().nullable() })
            .parse(await response.json());

          if (
            mounted.current &&
            current.sequence === live.current.sequence &&
            current.enabled === live.current.enabled
          ) {
            setStatus(result.connected ? "Ready" : "Waiting for Codex");
            setContext(result.context);
          }
        })
        .catch(() => {
          if (mounted.current && current.sequence === live.current.sequence) {
            setStatus("Selection unavailable");
            setContext(null);
          }
        });
    },
    [session, instanceId],
  );

  useEffect(() => {
    const timer = setTimeout(() => publish(), enabled ? 150 : 0);

    return () => clearTimeout(timer);
  }, [enabled, selection, publish]);
  useEffect(() => {
    mounted.current = true;

    const timer = setInterval(() => {
      if (live.current.enabled) publish();
    }, 10000);

    return () => {
      mounted.current = false;
      clearInterval(timer);
      publish(true);
    };
  }, [publish]);

  return (
    <SelectionContext.Provider value={select}>
      {children}
      <aside
        className="codex-context-control"
        aria-label="Codex selection context"
      >
        <label>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />{" "}
          Codex context
        </label>
        {enabled && (
          <>
            <span title={selection?.title}>
              {selection
                ? `${status}: ${selection.title}`
                : "Select text, code, or a diagram element"}
            </span>
            {selection && (
              <button type="button" onClick={() => select(null)}>
                Clear
              </button>
            )}
            {selection && context && (
              <pre
                className="codex-context-preview"
                aria-label="Full Codex context"
              >
                {context}
              </pre>
            )}
          </>
        )}
      </aside>
    </SelectionContext.Provider>
  );
}
