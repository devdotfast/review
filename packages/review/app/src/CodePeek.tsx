import type {
  ReviewDiffSide,
  ReviewInlineEditorHeightMode,
  ReviewInlineEditorRange,
} from "@dev.fast/review-protocol";
import { useMemo, useRef } from "react";

import type { ReviewComponentProps } from "../../src/review-document-data";
import {
  type Source,
  type CodeEvidence,
  evidenceLocation,
  codePeekSource,
} from "../../src/source";
import { useReviewSession } from "./host/review-session";
import { InlineCodeEditor } from "./InlineCodeEditor";

/** The software-map inspector's peek input: a range on one diff side. */
export interface CodePeekProps {
  file: string;
  fromLine: number;
  toLine: number;
  graph?: "head" | "base";
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

  return <CodePeekCard source={source} heightMode="content" />;
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
}: {
  peeks: readonly Source[];
  collapsed?: boolean;
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
            <InlineCodeEditor
              path={group.file}
              title={group.file}
              side={group.side}
              ranges={group.ranges}
              heightMode="content"
              countRanges={group.countRanges}
              active={false}
              collapsed={collapsed}
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

export function CodePeekCard({
  source,
  active = false,
  heightMode = "capped",
  onNativeFocus,
}: {
  source: CodeEvidence;
  active?: boolean;
  heightMode?: ReviewInlineEditorHeightMode;
  onNativeFocus?: () => void;
}) {
  const session = useReviewSession();

  const subject = useMemo(() => codePeekSubject(source), [source]);

  const onNativeFocusRef = useRef(onNativeFocus);
  onNativeFocusRef.current = onNativeFocus;

  return (
    <section className="code-peek" data-code-rendering="inline-editor">
      <InlineCodeEditor
        path={subject.file}
        title={subject.title}
        side={evidenceLocation(source).side}
        evidence={source}
        ranges={[{ startLine: subject.line, endLine: subject.endLine }]}
        heightMode={heightMode}
        active={active}
        onFocus={() => onNativeFocusRef.current?.()}
        onOpen={() =>
          session.surface.revealAnchor(
            subject.file,
            { fromLine: subject.line, toLine: subject.endLine },
            evidenceLocation(source).side,
          )
        }
      />
    </section>
  );
}

export function codePeekSubject(evidence: CodeEvidence): CodePeekSubject {
  const source = evidenceLocation(evidence);
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

function groupedCodePeeks(peeks: readonly Source[]): GroupedCodePeek[] {
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
