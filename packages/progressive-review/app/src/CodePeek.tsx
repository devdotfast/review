import type {
  ReviewDiffSide,
  ReviewInlineEditorHeightMode,
  ReviewInlineEditorRange,
} from "@dev.fast/review-protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type AnchorRef,
  type CodePeekProps as AuthoringCodePeekProps,
  type CodePeekDiffPayload,
  type CodePeekRef,
  type ReviewCodePeekProps,
  validateCodePeekProps,
} from "../../src/authoring";
import type { SourceSnapshot } from "../../src/source-code-types";
import type { ReviewSession } from "./host/review-session";
import { useReviewSession } from "./host/review-session";
import { InlineCodeEditor } from "./InlineCodeEditor";
import { captureUiEvent } from "./ui-telemetry";

type CodePeekRootSpec = {
  kind: "range";
  file: string;
  fromLine: number;
  toLine: number;
};

export type CodePeekProps = AuthoringCodePeekProps;
export type CodePeekGraph = NonNullable<CodePeekProps["graph"]>;
export type CodePeekTheme = NonNullable<CodePeekProps["theme"]>;

const validatedCodePeekInput = Symbol("validatedCodePeekInput");

export interface ValidatedCodePeekInput {
  readonly [validatedCodePeekInput]: true;
  readonly props: CodePeekProps;
  readonly resolution?: CodePeekResolveResult;
}

export interface CodePeekSubject {
  name?: string;
  title: string;
  file: string;
  line: number;
  endLine: number;
}

interface CodePeekResolveResult {
  snapshot: SourceSnapshot;
  diff?: CodePeekDiffPayload;
}

interface CodePeekResolveInput {
  root: CodePeekRootSpec;
  graph: CodePeekGraph;
  includeDiff: false;
  includeDiffSummary: true;
}

export function codePeekLoadState(input: {
  requestKey: string;
  pendingKey: string | null;
  displayedKey: string | null;
  error: string | null;
}): { isInitialLoad: boolean; isRefreshing: boolean } {
  const hasDisplayedResult = input.displayedKey !== null;
  // Effects do not run until after the first paint. Treat a resolvable request
  // as pending immediately so a newly opened peek never flashes an empty body.
  const hasPendingRequest =
    input.pendingKey !== null ||
    (input.requestKey !== "" && !hasDisplayedResult && input.error === null);
  return {
    isInitialLoad: hasPendingRequest && !hasDisplayedResult,
    isRefreshing: input.pendingKey !== null && hasDisplayedResult,
  };
}

export function validatedCodePeekInputFromRef(
  ref: CodePeekRef,
): ValidatedCodePeekInput {
  if (!ref.resolution) {
    throw new Error(
      "CodePeek received an unresolved pointer. defineAnchors must finish before React mounts.",
    );
  }
  return {
    [validatedCodePeekInput]: true,
    props: ref.props,
    resolution: ref.resolution,
  };
}

// Internal interactive surface used by the software-map inspector. Authored
// Review documents receive ReviewCodePeek instead, which only accepts a
// pointer resolved by defineAnchors.
export function CodePeek(props: CodePeekProps) {
  return (
    <CodePeekView
      input={{
        [validatedCodePeekInput]: true,
        props: validateCodePeekProps(props),
      }}
      heightMode="content"
    />
  );
}

interface CodePeekResolutionState {
  resolution?: CodePeekResolveResult;
  status?: string;
  error?: string;
}

interface CodePeekGroupEntry {
  key: string;
  input: ValidatedCodePeekInput;
}

interface ResolvedCodePeekGroup {
  key: string;
  file: string;
  graph: CodePeekGraph;
  ranges: ReviewInlineEditorRange[];
  diffStats?: { additions: number; deletions: number };
}

interface ResolvedCodePeekRange extends ReviewInlineEditorRange {
  side: ReviewDiffSide;
}

export function CodePeekGroup({
  peeks,
  collapsed = false,
}: {
  peeks: readonly CodePeekProps[];
  collapsed?: boolean;
}) {
  const session = useReviewSession();
  const entries = useMemo<CodePeekGroupEntry[]>(
    () =>
      peeks.map((props) => {
        const validated = validateCodePeekProps(props);
        return {
          key: codePeekPropsKey(validated),
          input: {
            [validatedCodePeekInput]: true,
            props: validated,
          },
        };
      }),
    [peeks],
  );
  const [states, setStates] = useState(
    () => new Map<string, CodePeekResolutionState>(),
  );
  const updateState = useCallback(
    (key: string, state: CodePeekResolutionState) => {
      setStates((current) => {
        const previous = current.get(key);
        if (
          previous?.resolution === state.resolution &&
          previous?.status === state.status &&
          previous?.error === state.error
        ) {
          return current;
        }
        const next = new Map(current);
        next.set(key, state);
        return next;
      });
    },
    [],
  );
  const settled = entries.every((entry) => {
    const state = states.get(entry.key);
    return state && !state.status;
  });
  const groups = useMemo(
    () => (settled ? resolvedCodePeekGroups(entries, states) : []),
    [entries, settled, states],
  );
  const pending = entries.length > 0 && !settled;
  const errors = entries.flatMap((entry) => {
    const error = states.get(entry.key)?.error;
    return error ? [error] : [];
  });

  return (
    <>
      {entries.map((entry) => (
        <CodePeekResolutionReporter
          key={entry.key}
          entry={entry}
          onChange={updateState}
        />
      ))}
      {groups.map((group) => {
        const primaryRange = group.ranges[0]!;
        return (
          <section
            key={group.key}
            className="code-peek"
            data-code-rendering="inline-editor"
          >
            <InlineCodeEditor
              path={group.file}
              title={group.file}
              side={group.graph}
              ranges={group.ranges}
              heightMode="content"
              diffStats={group.diffStats}
              active={false}
              commentsEnabled
              collapsed={collapsed}
              onOpen={() =>
                session.surface.revealAnchor(
                  group.file,
                  {
                    fromLine: primaryRange.startLine,
                    toLine: primaryRange.endLine,
                  },
                  primaryRange.side ?? group.graph,
                )
              }
            />
          </section>
        );
      })}
      {groups.length === 0 && pending ? (
        <div className="peek-status" role="status">
          Resolving code locations...
        </div>
      ) : null}
      {groups.length === 0 && !pending && errors.length > 0 ? (
        <div className="peek-error">{errors[0]}</div>
      ) : null}
    </>
  );
}

function CodePeekResolutionReporter({
  entry,
  onChange,
}: {
  entry: CodePeekGroupEntry;
  onChange: (key: string, state: CodePeekResolutionState) => void;
}) {
  const state = useCodePeekResolution(entry.input);
  useEffect(() => {
    onChange(entry.key, state);
  }, [entry.key, onChange, state.error, state.resolution, state.status]);
  return null;
}

export function ReviewCodePeek({ anchor }: ReviewCodePeekProps) {
  const input = useMemo(
    () => validatedCodePeekInputFromRef(anchor.peek),
    [anchor.peek],
  );
  return <CodePeekView input={input} commentAnchor={anchor} />;
}

export function CodePeekView({
  input,
  heightMode = "capped",
  commentAnchor,
}: {
  input: ValidatedCodePeekInput;
  heightMode?: ReviewInlineEditorHeightMode;
  commentAnchor?: AnchorRef;
}) {
  const { resolution, status, error } = useCodePeekResolution(input);

  return (
    <CodePeekCard
      input={input}
      resolution={resolution}
      status={status}
      error={error}
      heightMode={heightMode}
      commentAnchor={commentAnchor}
    />
  );
}

function useCodePeekResolution(
  input: ValidatedCodePeekInput,
): CodePeekResolutionState {
  const session = useReviewSession();
  const { file, fromLine, toLine } = input.props;
  const graph = input.props.graph ?? "head";
  const [resolution, setResolution] = useState<CodePeekResolveResult | null>(
    input.resolution ?? null,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootSpec = useMemo(
    () => codePeekRootFromProps(input.props),
    [file, fromLine, toLine],
  );
  const requestInput = useMemo<CodePeekResolveInput | null>(
    () =>
      rootSpec
        ? {
            root: rootSpec,
            graph,
            includeDiff: false,
            includeDiffSummary: true,
          }
        : null,
    [graph, rootSpec],
  );
  const requestInputRef = useRef(requestInput);
  requestInputRef.current = requestInput;
  const requestPath = useMemo(
    () => session.apiUrl("/code-peek/resolve"),
    [session],
  );
  const requestKey = useMemo(
    () =>
      requestInput ? JSON.stringify(requestInput) : "",
    [requestInput],
  );

  useEffect(() => {
    let cancelled = false;
    if (input.resolution) {
      setResolution(input.resolution);
      setPending(false);
      setError(null);
      return () => {
        cancelled = true;
      };
    }

    const nextRequestInput = requestInputRef.current;
    if (!nextRequestInput || !requestKey) {
      setResolution(null);
      setPending(false);
      setError(null);
      return () => {
        cancelled = true;
      };
    }

    setResolution(null);
    setPending(true);
    setError(null);
    void fetchCodePeekResultWithRetry(
      session,
      nextRequestInput,
      requestPath,
      () => cancelled,
    )
      .then((result) => {
        if (cancelled) return;
        if (isCodePeekNoMatch(result)) {
          captureUiEvent(session, "peek_resolve_failed", {
            root_kind: nextRequestInput.root.kind,
          });
        } else {
          captureUiEvent(session, "peek_resolved", {
            root_kind: nextRequestInput.root.kind,
          });
        }
        setResolution(result);
        setPending(false);
      })
      .catch((caught) => {
        if (cancelled) return;
        captureUiEvent(session, "peek_resolve_failed", {
          root_kind: nextRequestInput.root.kind,
        });
        setPending(false);
        setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [input.resolution, requestKey, requestPath, session]);

  const { isInitialLoad } = codePeekLoadState({
    requestKey,
    pendingKey: pending ? requestKey : null,
    displayedKey: resolution ? requestKey : null,
    error,
  });

  return {
    resolution: input.resolution ?? resolution ?? undefined,
    status: isInitialLoad ? "Resolving code location..." : undefined,
    error: error ?? undefined,
  };
}

export function CodePeekCard({
  input,
  resolution = input.resolution,
  status,
  error,
  active = false,
  heightMode = "capped",
  onNativeFocus,
  commentAnchor,
}: {
  input: ValidatedCodePeekInput;
  resolution?: CodePeekResolveResult;
  status?: string;
  error?: string;
  active?: boolean;
  heightMode?: ReviewInlineEditorHeightMode;
  onNativeFocus?: () => void;
  commentAnchor?: AnchorRef;
}) {
  const session = useReviewSession();
  const subject = useMemo(
    () => codePeekSubject(input, resolution),
    [input, resolution],
  );
  const onNativeFocusRef = useRef(onNativeFocus);
  onNativeFocusRef.current = onNativeFocus;

  const diffCounts = useMemo(
    () =>
      subject && resolution?.diff
        ? codePeekDiffCountsForSubject(resolution.diff, subject)
        : undefined,
    [resolution?.diff, subject],
  );
  return (
    <section className="code-peek" data-code-rendering="inline-editor">
      {status ? (
        <div className="peek-status" role="status">
          {status}
        </div>
      ) : null}
      {error && !subject ? <div className="peek-error">{error}</div> : null}
      {!subject && !status && !error ? (
        <div className="peek-status">
          No code location is attached here yet.
        </div>
      ) : null}
      {subject && commentAnchor ? (
        <AuthoredCodePeekEditor
          input={input}
          subject={subject}
          heightMode={heightMode}
          diffStats={diffCounts}
          active={active}
          onNativeFocus={onNativeFocus}
        />
      ) : subject ? (
        <InlineCodeEditor
          path={subject.file}
          title={subject.title}
          side={input.props.graph ?? "head"}
          ranges={[{ startLine: subject.line, endLine: subject.endLine }]}
          heightMode={heightMode}
          diffStats={diffCounts}
          active={active}
          onFocus={() => onNativeFocusRef.current?.()}
          onOpen={() =>
            session.surface.revealAnchor(
              subject.file,
              { fromLine: subject.line, toLine: subject.endLine },
              input.props.graph ?? "head",
            )
          }
        />
      ) : null}
    </section>
  );
}

function AuthoredCodePeekEditor({
  input,
  subject,
  heightMode,
  diffStats,
  active,
  onNativeFocus,
}: {
  input: ValidatedCodePeekInput;
  subject: CodePeekSubject;
  heightMode: ReviewInlineEditorHeightMode;
  diffStats?: { additions: number; deletions: number };
  active: boolean;
  onNativeFocus?: () => void;
}) {
  const session = useReviewSession();
  const graph = input.props.graph ?? "head";

  return (
    <div>
      <InlineCodeEditor
        path={subject.file}
        title={subject.title}
        side={graph}
        ranges={[{ startLine: subject.line, endLine: subject.endLine }]}
        heightMode={heightMode}
        diffStats={diffStats}
        active={active}
        onFocus={onNativeFocus}
        onOpen={() =>
          session.surface.revealAnchor(
            subject.file,
            { fromLine: subject.line, toLine: subject.endLine },
            graph,
          )
        }
        commentsEnabled
      />
    </div>
  );
}

export function codePeekDiffCountsForSubject(
  diff: CodePeekDiffPayload,
  subject: Pick<CodePeekSubject, "file">,
): { additions: number; deletions: number } {
  const file = diff.files.find(
    (candidate) =>
      candidate.path === subject.file ||
      candidate.previousPath === subject.file,
  );
  return file
    ? { additions: file.additions, deletions: file.deletions }
    : { additions: 0, deletions: 0 };
}

function codePeekRootFromProps(input: {
  file?: string;
  fromLine?: number;
  toLine?: number;
}): CodePeekRootSpec | null {
  if (
    input.file &&
    typeof input.fromLine === "number" &&
    typeof input.toLine === "number"
  ) {
    return {
      kind: "range",
      file: input.file,
      fromLine: input.fromLine,
      toLine: input.toLine,
    };
  }
  return null;
}

export function codePeekSubject(
  input: ValidatedCodePeekInput,
  resolution: CodePeekResolveResult | null | undefined = input.resolution,
): CodePeekSubject | undefined {
  if (!resolution) return undefined;
  const root = codePeekRootFromProps(input.props);
  if (!root) return undefined;
  return {
    title: codePeekRangeTitle(root.file, root.fromLine, root.toLine),
    file: root.file,
    line: root.fromLine,
    endLine: root.toLine,
  };
}

// The card header prints one label, and it elides from the left. So give it the
// whole path. A narrow card then keeps the deepest folders and the file name.
function codePeekRangeTitle(
  file: string,
  fromLine: number,
  toLine: number,
): string {
  const range = fromLine === toLine ? `${fromLine}` : `${fromLine}-${toLine}`;
  return `${file}:${range}`;
}

function codePeekPropsKey(props: CodePeekProps): string {
  return JSON.stringify(props);
}

function resolvedCodePeekGroups(
  entries: readonly CodePeekGroupEntry[],
  states: ReadonlyMap<string, CodePeekResolutionState>,
): ResolvedCodePeekGroup[] {
  const groups = new Map<
    string,
    Omit<ResolvedCodePeekGroup, "ranges"> & {
      ranges: ResolvedCodePeekRange[];
      hasDiffStats: boolean;
    }
  >();
  for (const entry of entries) {
    const resolution = states.get(entry.key)?.resolution;
    const subject = codePeekSubject(entry.input, resolution);
    if (!subject) continue;
    const graph = entry.input.props.graph ?? "head";
    const key = subject.file;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        file: subject.file,
        graph,
        ranges: [],
        hasDiffStats: false,
      };
      groups.set(key, group);
    } else if (graph === "head") {
      group.graph = "head";
    }
    group.ranges.push({
      startLine: subject.line,
      endLine: subject.endLine,
      side: graph,
    });
    if (resolution?.diff) {
      const counts = codePeekDiffCountsForSubject(resolution.diff, subject);
      group.diffStats = {
        additions: (group.diffStats?.additions ?? 0) + counts.additions,
        deletions: (group.diffStats?.deletions ?? 0) + counts.deletions,
      };
      group.hasDiffStats = true;
    }
  }
  return [...groups.values()].map(({ hasDiffStats, ...group }) => ({
    ...group,
    ranges: mergedCodePeekRanges(group.ranges, group.graph),
    diffStats: hasDiffStats ? group.diffStats : undefined,
  }));
}

function mergedCodePeekRanges(
  ranges: readonly ResolvedCodePeekRange[],
  defaultSide: ReviewDiffSide,
): ReviewInlineEditorRange[] {
  const merged: ReviewInlineEditorRange[] = [];
  const sides: readonly ReviewDiffSide[] =
    defaultSide === "head" ? ["head", "base"] : ["base", "head"];
  for (const side of sides) {
    const sideRanges = ranges
      .filter((range) => range.side === side)
      .sort((left, right) => left.startLine - right.startLine);
    const mergedForSide: ResolvedCodePeekRange[] = [];
    for (const range of sideRanges) {
      const previous = mergedForSide.at(-1);
      if (!previous || range.startLine > previous.endLine + 1) {
        mergedForSide.push({ ...range });
      } else {
        previous.endLine = Math.max(previous.endLine, range.endLine);
      }
    }
    for (const range of mergedForSide) {
      const compactRange: ReviewInlineEditorRange = {
        startLine: range.startLine,
        endLine: range.endLine,
      };
      if (side !== defaultSide) compactRange.side = side;
      merged.push(compactRange);
    }
  }
  return merged;
}

function isCodePeekNoMatch(result: CodePeekResolveResult): boolean {
  return (
    result.snapshot.roots.length === 0 && (result.diff?.files.length ?? 0) === 0
  );
}

async function fetchCodePeekResult(
  session: ReviewSession,
  input: CodePeekResolveInput,
  requestPath: string,
): Promise<CodePeekResolveResult> {
  const response = await session.fetchUrl(requestPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const json = (await response.json()) as
    | { ok: true; snapshot: SourceSnapshot; diff?: CodePeekDiffPayload }
    | { ok: false; error?: string };
  if (!response.ok || !json.ok) {
    throw new Error(
      json.ok
        ? "CodePeek resolve failed"
        : (json.error ?? "CodePeek resolve failed"),
    );
  }
  return { snapshot: json.snapshot, diff: json.diff };
}

async function fetchCodePeekResultWithRetry(
  session: ReviewSession,
  input: CodePeekResolveInput,
  requestPath: string,
  isCancelled: () => boolean,
): Promise<CodePeekResolveResult> {
  if (isCancelled()) throw new Error("Cancelled");
  const delays = [0, 250, 1_000];
  let lastError: unknown;
  for (const delayMs of delays) {
    if (delayMs > 0) await delay(delayMs);
    if (isCancelled()) {
      throw lastError instanceof Error ? lastError : new Error("Cancelled");
    }
    try {
      return await fetchCodePeekResult(session, input, requestPath);
    } catch (caught) {
      lastError = caught;
      if (!isRetryableCodePeekError(caught)) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isRetryableCodePeekError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return error.message.includes("fetch");
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
