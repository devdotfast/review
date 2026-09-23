import type {
  WhiteboardDiffSide,
  WhiteboardInlineEditorHeightMode,
  WhiteboardInlineEditorRange,
} from "@dev.fast/whiteboard-protocol";
import { useMemo, useRef } from "react";

import { type DiffSelection, sourceAnchor } from "../../src/lens-selection";
import { type FileLineRange, codePeekSource } from "../../src/source";
import type { WhiteboardComponentProps } from "../../src/whiteboard-document-data";
import { DocumentCodeView } from "./DocumentCodeView";
import { useWhiteboardSession } from "./host/whiteboard-session";
import {
  type WhiteboardLensView,
  useWhiteboardLenses,
} from "./whiteboard-lenses";

/** The software-map inspector's peek input: a range on one diff side. */
export interface CodePeekProps {
  file: string;
  fromLine: number;
  toLine: number;
  graph?: "head" | "base";
  lenses?: WhiteboardLensView;
}

export interface CodePeekSubject {
  title: string;
  file: string;
  line: number;
  endLine: number;
}

// Internal interactive surface used by the software-map inspector. Authored
// Review documents receive WhiteboardCodePeek instead.
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
  side: WhiteboardDiffSide;
  ranges: WhiteboardInlineEditorRange[];
  countRanges?: WhiteboardInlineEditorRange[];
}

interface AuthoredCodePeekRange extends WhiteboardInlineEditorRange {
  side: WhiteboardDiffSide;
}

export function CodePeekGroup({
  peeks,
  collapsed = false,
  lenses,
}: {
  peeks: readonly FileLineRange[];
  collapsed?: boolean;
  lenses?: WhiteboardLensView;
}) {
  const session = useWhiteboardSession();

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

export function WhiteboardCodePeek({
  anchor,
}: WhiteboardComponentProps<"CodePeek">) {
  return <CodePeekCard source={anchor.peek} />;
}

/** A document peek is an interval of the same alignment used by diff lenses. */
export function CodePeekCard({
  source,
  active = false,
  heightMode = "capped",
  onNativeFocus,
  lenses: lensesOverride,
}: {
  source: DiffSelection;
  active?: boolean;
  heightMode?: WhiteboardInlineEditorHeightMode;
  onNativeFocus?: () => void;
  lenses?: WhiteboardLensView;
}) {
  const session = useWhiteboardSession();
  const contextLenses = useWhiteboardLenses();
  const lenses = lensesOverride ?? contextLenses;
  const resolved = lenses?.resolve([source]) ?? [];
  const anchor = sourceAnchor(source);

  const ranges = resolved.map((range) => ({
    side: range.side,
    startLine: range.fromLine,
    endLine: range.toLine,
  }));

  if (!ranges.length)
    return (
      <section className="code-peek" role="status">
        {lenses?.progress || lenses?.error
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
  heightMode?: WhiteboardInlineEditorHeightMode;
  onNativeFocus?: () => void;
  lenses?: WhiteboardLensView;
}) {
  const session = useWhiteboardSession();

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
  defaultSide: WhiteboardDiffSide,
): WhiteboardInlineEditorRange[] {
  const merged: WhiteboardInlineEditorRange[] = [];

  const sides: readonly WhiteboardDiffSide[] =
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
      const compactRange: WhiteboardInlineEditorRange = {
        startLine: range.startLine,
        endLine: range.endLine,
      };

      if (side !== defaultSide) compactRange.side = side;
      merged.push(compactRange);
    }
  }

  return merged;
}
