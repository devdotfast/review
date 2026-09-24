import type {
  ReviewDiffSide,
  ReviewInlineEditorHeightMode,
  ReviewInlineEditorRange,
} from "@dev.fast/review-protocol";
import { useEffect, useMemo, useRef } from "react";

import {
  type DiffSelection,
  selectionKey,
  sourceAnchor,
} from "../../src/lens-selection";
import type { ReviewComponentProps } from "../../src/review-document-data";
import { type FileLineRange, codePeekSource } from "../../src/source";
import { DocumentCodeView } from "./DocumentCodeView";
import { useReviewSession } from "./host/review-session";
import { peekResolutionOutcome } from "./peek-telemetry";
import { type ReviewLensView, useReviewLenses } from "./review-lenses";
import { captureUiEvent } from "./ui-telemetry";

/** The software-map inspector's peek input: a range on one diff side. */
export interface CodePeekProps {
  file: string;
  fromLine: number;
  toLine: number;
  graph?: "head" | "base";
  lenses?: ReviewLensView;
}

export interface CodePeekSubject {
  title: string;
  file: string;
  line: number;
  endLine: number;
}

// Internal interactive surface used by the software-map inspector. Authored
// Review documents receive ReviewCodePeek instead.
export function CodePeek(props: CodePeekProps) {
  const source = useMemo(() => codePeekSource(props), [props]);

  return (
    <FileSnippetCard
      source={source}
      heightMode="content"
      lenses={props.lenses}
    />
  );
}

interface GroupedCodePeek {
  key: string;
  file: string;
  side: ReviewDiffSide;
  ranges: ReviewInlineEditorRange[];
  countRanges?: ReviewInlineEditorRange[];
}

interface AuthoredCodePeekRange extends ReviewInlineEditorRange {
  side: ReviewDiffSide;
}

export function CodePeekGroup({
  peeks,
  collapsed = false,
  lenses,
}: {
  peeks: readonly FileLineRange[];
  collapsed?: boolean;
  lenses?: ReviewLensView;
}) {
  const session = useReviewSession();

  const groups = useMemo(() => groupedCodePeeks(peeks), [peeks]);

  return (
    <>
      {groups.map((group) => {
        const primaryRange = group.ranges[0]!;

        return (
          <section
            key={group.key}
            className="code-peek"
            data-code-rendering="inline-editor"
          >
            <DocumentCodeView
              path={group.file}
              title={group.file}
              side={group.side}
              ranges={group.ranges}
              heightMode="content"
              countRanges={group.countRanges}
              active={false}
              collapsed={collapsed}
              lenses={lenses}
              onOpen={() =>
                session.surface.revealAnchor(
                  group.file,
                  {
                    fromLine: primaryRange.startLine,
                    toLine: primaryRange.endLine,
                  },
                  primaryRange.side ?? group.side,
                )
              }
            />
          </section>
        );
      })}
    </>
  );
}

export function ReviewCodePeek({ anchor }: ReviewComponentProps<"CodePeek">) {
  return <CodePeekCard source={anchor.peek} />;
}

/** A document peek is an interval of the same alignment used by diff lenses. */
export function CodePeekCard({
  source,
  active = false,
  heightMode = "capped",
  onNativeFocus,
  lenses: lensesOverride,
  reportOutcome = false,
}: {
  source: DiffSelection;
  active?: boolean;
  heightMode?: ReviewInlineEditorHeightMode;
  onNativeFocus?: () => void;
  lenses?: ReviewLensView;
  /** Report resolution telemetry. Only the panel the user opened sets this,
   * so an authored document with many inline peeks sends one event, not N. */
  reportOutcome?: boolean;
}) {
  const session = useReviewSession();
  const contextLenses = useReviewLenses();
  const lenses = lensesOverride ?? contextLenses;
  const resolved = lenses?.resolve([source]) ?? [];
  const anchor = sourceAnchor(source);

  const ranges = resolved.map((range) => ({
    side: range.side,
    startLine: range.fromLine,
    endLine: range.toLine,
  }));

  const key = selectionKey(source);

  const outcome = peekResolutionOutcome({
    resolvedCount: ranges.length,
    complete: Boolean(lenses?.progress?.complete),
    unavailable: Boolean(lenses?.progress?.unavailableSelections?.[key]),
    error: Boolean(lenses?.error),
  });

  const reportedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!reportOutcome || outcome === "pending" || reportedKey.current === key)
      return;
    reportedKey.current = key;
    captureUiEvent(
      session,
      outcome === "resolved" ? "peek_resolved" : "peek_resolve_failed",
      { root_kind: "range" },
    );
  }, [key, outcome, reportOutcome, session]);

  if (!ranges.length)
    return (
      <section className="code-peek" role="status">
        {outcome === "failed"
          ? "Diff selection unavailable"
          : "Loading diff selection…"}
      </section>
    );

  return (
    <section className="code-peek" data-code-rendering="inline-editor">
      <DocumentCodeView
        path={source.file}
        title={
          source.start.side === source.end.side
            ? codePeekRangeTitle(
                source.file,
                source.start.line,
                source.end.line,
              )
            : source.file
        }
        side={anchor.side}
        pins={source.pins}
        ranges={ranges}
        countRanges={ranges}
        heightMode={heightMode}
        active={active}
        onFocus={onNativeFocus}
        onOpen={() =>
          session.surface.revealAnchor(
            anchor.file,
            { fromLine: anchor.fromLine, toLine: anchor.toLine },
            anchor.side,
            source.pins,
          )
        }
      />
    </section>
  );
}

function FileSnippetCard({
  source,
  active = false,
  heightMode = "capped",
  onNativeFocus,
  lenses,
}: {
  source: FileLineRange;
  active?: boolean;
  heightMode?: ReviewInlineEditorHeightMode;
  onNativeFocus?: () => void;
  lenses?: ReviewLensView;
}) {
  const session = useReviewSession();

  const subject = useMemo(() => codePeekSubject(source), [source]);

  const onNativeFocusRef = useRef(onNativeFocus);
  onNativeFocusRef.current = onNativeFocus;

  return (
    <section className="code-peek" data-code-rendering="inline-editor">
      <DocumentCodeView
        path={subject.file}
        title={subject.title}
        side={source.side}
        pins={source.pins}
        ranges={[{ startLine: subject.line, endLine: subject.endLine }]}
        heightMode={heightMode}
        active={active}
        lenses={lenses}
        onFocus={() => onNativeFocusRef.current?.()}
        onOpen={() =>
          session.surface.revealAnchor(
            subject.file,
            { fromLine: subject.line, toLine: subject.endLine },
            source.side,
            source.pins,
          )
        }
      />
    </section>
  );
}

export function codePeekSubject(source: FileLineRange): CodePeekSubject {
  return {
    title: codePeekRangeTitle(source.file, source.fromLine, source.toLine),
    file: source.file,
    line: source.fromLine,
    endLine: source.toLine,
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

function groupedCodePeeks(peeks: readonly FileLineRange[]): GroupedCodePeek[] {
  const groups = new Map<
    string,
    Omit<GroupedCodePeek, "ranges"> & {
      ranges: AuthoredCodePeekRange[];
    }
  >();

  for (const peek of peeks) {
    const key = peek.file;
    let group = groups.get(key);

    if (!group) {
      group = {
        key,
        file: peek.file,
        side: peek.side,
        ranges: [],
      };
      groups.set(key, group);
    } else if (peek.side === "head") {
      group.side = "head";
    }

    group.ranges.push({
      startLine: peek.fromLine,
      endLine: peek.toLine,
      side: peek.side,
    });
  }

  return [...groups.values()].map((group) => ({
    ...group,
    countRanges: group.ranges,
    ranges: mergedCodePeekRanges(group.ranges, group.side),
  }));
}

function mergedCodePeekRanges(
  ranges: readonly AuthoredCodePeekRange[],
  defaultSide: ReviewDiffSide,
): ReviewInlineEditorRange[] {
  const merged: ReviewInlineEditorRange[] = [];

  const sides: readonly ReviewDiffSide[] =
    defaultSide === "head" ? ["head", "base"] : ["base", "head"];

  for (const side of sides) {
    const sideRanges = ranges
      .filter((range) => range.side === side)
      .sort((left, right) => left.startLine - right.startLine);

    const mergedForSide: AuthoredCodePeekRange[] = [];

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
