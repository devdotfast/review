import type { AnchorRef } from "../../src/authoring";
import type { ThreadTarget } from "../../src/types";
import {
  codeTargetResource,
  projectCodeTarget,
  resolvedCodeSurface,
  targetIdentityKey,
} from "./target-fingerprint";

export interface ReviewSessionCommits {
  baseRef: string | null;
  headRef: string | null;
}

export interface ThreadTargetIndex<T extends { target: ThreadTarget }> {
  exact: ReadonlyMap<string, readonly T[]>;
  anchorText: ReadonlyMap<string, readonly T[]>;
  code: ReadonlyMap<string, readonly T[]>;
}

export function buildThreadTargetIndex<T extends { target: ThreadTarget }>(
  records: Iterable<T>,
): ThreadTargetIndex<T> {
  const exact = new Map<string, T[]>();
  const anchorText = new Map<string, T[]>();
  const code = new Map<string, T[]>();
  for (const record of records) {
    appendIndexValue(exact, targetIdentityKey(record.target), record);
    if (
      record.target.kind === "text" &&
      record.target.surface.type === "anchor"
    ) {
      appendIndexValue(anchorText, record.target.surface.anchorId, record);
    } else if (record.target.kind === "code") {
      for (const key of codeTargetIndexKeys(record.target)) {
        appendIndexValue(code, key, record);
      }
    }
  }
  return { exact, anchorText, code };
}

export function exactTargetRecords<T extends { target: ThreadTarget }>(
  index: ThreadTargetIndex<T>,
  target: ThreadTarget,
): readonly T[] {
  return index.exact.get(targetIdentityKey(target)) ?? [];
}

export function anchorTargetRecords<T extends { target: ThreadTarget }>(
  index: ThreadTargetIndex<T>,
  anchor: AnchorRef,
  commits: ReviewSessionCommits,
): readonly T[] {
  const candidates = new Set([
    ...(index.anchorText.get(anchor.id) ?? []),
    ...codeIndexKeysForAnchor(anchor, commits).flatMap(
      (key) => index.code.get(key) ?? [],
    ),
  ]);
  return [...candidates].filter((record) =>
    targetAppearsInAnchor(record.target, anchor, commits),
  );
}

export function targetAppearsInAnchor(
  target: ThreadTarget,
  anchor: AnchorRef,
  commits: ReviewSessionCommits,
): boolean {
  if (target.kind !== "code") {
    return (
      target.kind === "text" &&
      target.surface.type === "anchor" &&
      target.surface.anchorId === anchor.id
    );
  }

  const peek = anchor.peek;
  const resolution = peek?.resolution;
  if (!resolution) return false;
  const source = resolvedCodeSurface(resolution);
  const snapshotSide =
    resolution.diff?.orientation ?? peek.props.graph ?? "head";
  if (!resolution.diff) {
    const projection = projectCodeTarget(target, snapshotSide);
    const expectedCommit =
      snapshotSide === "base" ? commits.baseRef : commits.headRef;
    return (
      projection?.commit === expectedCommit &&
      projection.path === source.file &&
      codeSpanOverlapsSource(projection.span, source)
    );
  }

  const diffFile = resolution.diff.files.find(
    (file) => file.path === source.file || file.previousPath === source.file,
  );
  if (!diffFile) return false;
  for (const side of ["base", "head"] as const) {
    const projection = projectCodeTarget(target, side, diffFile.patch);
    if (!projection) continue;
    const expectedCommit = side === "base" ? commits.baseRef : commits.headRef;
    const expectedPath =
      side === "base"
        ? (diffFile.previousPath ?? diffFile.path)
        : diffFile.path;
    if (
      projection.commit !== expectedCommit ||
      projection.path !== expectedPath
    ) {
      continue;
    }
    // The opposite side source loads on demand. The code surface checks its
    // projected range after that load.
    if (
      side !== snapshotSide ||
      codeSpanOverlapsSource(projection.span, source)
    ) {
      return true;
    }
  }
  return false;
}

function codeIndexKeysForAnchor(
  anchor: AnchorRef,
  commits: ReviewSessionCommits,
): string[] {
  const peek = anchor.peek;
  const resolution = peek?.resolution;
  if (!resolution) return [];
  const source = resolvedCodeSurface(resolution);
  if (!resolution.diff) {
    const side = peek.props.graph ?? "head";
    const commit = side === "base" ? commits.baseRef : commits.headRef;
    return commit ? [codeIndexKey(commit, side, source.file)] : [];
  }
  const diffFile = resolution.diff.files.find(
    (file) => file.path === source.file || file.previousPath === source.file,
  );
  if (!diffFile) return [];
  return [
    ...(commits.baseRef
      ? [
          codeIndexKey(
            commits.baseRef,
            "base",
            diffFile.previousPath ?? diffFile.path,
          ),
        ]
      : []),
    ...(commits.headRef
      ? [codeIndexKey(commits.headRef, "head", diffFile.path)]
      : []),
  ];
}

function codeTargetIndexKeys(
  target: Extract<ThreadTarget, { kind: "code" }>,
): string[] {
  return (["base", "head"] as const).flatMap((side) => {
    const resource = codeTargetResource(target, side);
    return resource ? [codeIndexKey(resource.commit, side, resource.path)] : [];
  });
}

function codeIndexKey(
  commit: string,
  side: "base" | "head",
  path: string,
): string {
  return `${commit}\0${side}\0${path}`;
}

function codeSpanOverlapsSource(
  span: { startLine: number; endLine: number },
  source: { text: string; fromLine: number },
): boolean {
  // Native CodePeek renders three context lines around the authored source.
  const sourceStartLine = Math.max(1, source.fromLine - 3);
  const sourceEndLine =
    source.fromLine + source.text.split("\n").length - 1 + 3;
  return span.endLine >= sourceStartLine && span.startLine <= sourceEndLine;
}

function appendIndexValue<T>(
  map: Map<string, T[]>,
  key: string,
  value: T,
): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}
