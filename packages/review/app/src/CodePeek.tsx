import type {
  ReviewDiffSide,
  ReviewInlineEditorHeightMode,
  ReviewInlineEditorRange,
} from "@dev.fast/review-protocol";
import { useMemo, useRef } from "react";

import {
  type CodePeekProps as AuthoringCodePeekProps,
  type CodePeekRef,
  type ReviewCodePeekProps,
  validateCodePeekProps,
} from "../../src/authoring";
import { useReviewSession } from "./host/review-session";
import { InlineCodeEditor } from "./InlineCodeEditor";

type CodePeekRootSpec = {
  kind: "range";
  file: string;
  fromLine: number;
  toLine: number;
};

export type CodePeekProps = AuthoringCodePeekProps;

export type CodePeekGraph = NonNullable<CodePeekProps["graph"]>;

const validatedCodePeekInput = Symbol("validatedCodePeekInput");

export interface ValidatedCodePeekInput {
  readonly [validatedCodePeekInput]: true;
  readonly props: CodePeekProps;
}

export interface CodePeekSubject {
  name?: string;
  title: string;
  file: string;
  line: number;
  endLine: number;
}

export function validatedCodePeekInputFromRef(
  ref: CodePeekRef,
): ValidatedCodePeekInput {
  return {
    [validatedCodePeekInput]: true,
    props: ref.props,
  };
}

// Internal interactive surface used by the software-map inspector. Authored
// Review documents receive ReviewCodePeek instead, which only accepts a
// validated pointer created by defineAnchors.
export function CodePeek(props: CodePeekProps) {
  const input = useMemo<ValidatedCodePeekInput>(
    () => ({
      [validatedCodePeekInput]: true,
      props: validateCodePeekProps(props),
    }),
    [props],
  );

  return <CodePeekCard input={input} heightMode="content" />;
}

interface GroupedCodePeek {
  key: string;
  file: string;
  graph: CodePeekGraph;
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
  peeks: readonly CodePeekProps[];
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
              side={group.graph}
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
                  primaryRange.side ?? group.graph,
                )
              }
            />
          </section>
        );
      })}
    </>
  );
}

export function ReviewCodePeek({ anchor }: ReviewCodePeekProps) {
  const input = useMemo(
    () => validatedCodePeekInputFromRef(anchor.peek),
    [anchor.peek],
  );

  return <CodePeekCard input={input} />;
}

export function CodePeekCard({
  input,
  active = false,
  heightMode = "capped",
  onNativeFocus,
}: {
  input: ValidatedCodePeekInput;
  active?: boolean;
  heightMode?: ReviewInlineEditorHeightMode;
  onNativeFocus?: () => void;
}) {
  const session = useReviewSession();

  const subject = useMemo(() => codePeekSubject(input), [input]);

  const onNativeFocusRef = useRef(onNativeFocus);
  onNativeFocusRef.current = onNativeFocus;

  return (
    <section className="code-peek" data-code-rendering="inline-editor">
      {!subject ? (
        <div className="peek-status">
          No code location is attached here yet.
        </div>
      ) : null}
      {subject ? (
        <InlineCodeEditor
          path={subject.file}
          title={subject.title}
          side={input.props.graph ?? "head"}
          ranges={[{ startLine: subject.line, endLine: subject.endLine }]}
          heightMode={heightMode}
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

function codePeekRootFromProps(input: {
  file?: string;
  fromLine?: number;
  toLine?: number;
}): CodePeekRootSpec | null {
  if (
    input.file &&
    input.fromLine !== undefined &&
    input.toLine !== undefined
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
): CodePeekSubject | undefined {
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

function groupedCodePeeks(peeks: readonly CodePeekProps[]): GroupedCodePeek[] {
  const groups = new Map<
    string,
    Omit<GroupedCodePeek, "ranges"> & {
      ranges: AuthoredCodePeekRange[];
    }
  >();

  for (const props of peeks) {
    const input: ValidatedCodePeekInput = {
      [validatedCodePeekInput]: true,
      props: validateCodePeekProps(props),
    };

    const subject = codePeekSubject(input);

    if (!subject) continue;
    const graph = input.props.graph ?? "head";
    const key = subject.file;
    let group = groups.get(key);

    if (!group) {
      group = {
        key,
        file: subject.file,
        graph,
        ranges: [],
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
  }

  return [...groups.values()].map((group) => ({
    ...group,
    countRanges: group.ranges,
    ranges: mergedCodePeekRanges(group.ranges, group.graph),
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
