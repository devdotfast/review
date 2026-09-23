import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  StructuralDiff,
  StructuralDiffEvent,
  StructuralRegion,
} from "@dev.fast/whiteboard-protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { coverageProgress, coverageSources } from "../viewed-coverage.js";
import { SessionApiClient } from "./client.js";
import { foldedChanges } from "./comparison-coverage.js";
import { UNCATEGORIZED_LENS_ID } from "./diff-lenses.js";
import { createSessionApi } from "./http.js";
import { LocalSessionData } from "./local-data.js";
import { type SessionProviders, SessionStore } from "./store.js";
import type { WhiteboardProgress } from "./whiteboard-progress.js";

const pins = { repositoryId: "repo", base: "base-commit", head: "head-commit" };

const leaf = (
  id: number,
  alignment: number,
  [from, to]: [number, number],
  changed: number[] = [],
  collapsed = false,
): StructuralRegion => ({
  id,
  fold_state_id: id,
  kind: "leaf",
  alignment_id: alignment,
  start: { line: from, column: 0 },
  end: { line: to, column: 0 },
  changed: changed.map((line) => ({ line, start_column: 0, end_column: 1 })),
  ...(collapsed && { visibility: { collapsed } }),
});

const fold = (
  id: number,
  [from, to]: [number, number],
  collapsed: boolean,
  children: StructuralRegion[],
): StructuralRegion => ({
  id,
  fold_state_id: id,
  kind: "fold",
  start: { line: from, column: 0 },
  end: { line: to, column: 0 },
  visibility: { collapsed },
  children,
});

const text = (lines: number) =>
  Array.from({ length: lines }, (_, line) => `line ${line}`).join("\n");

/** One changed line in a function, and a test module diffr folds whose three
 * added lines pair with nothing. */
const sourceDiff: StructuralDiff = {
  type: "text",
  lhs: { text: text(2), regions: [leaf(1, 1, [0, 1], [0])] },
  rhs: {
    text: text(6),
    regions: [
      leaf(2, 1, [0, 1], [0]),
      fold(3, [2, 5], true, [fold(4, [2, 5], false, [leaf(5, 5, [2, 5])])]),
    ],
  },
  structural_changes: {
    base: [[0, 1]],
    head: [
      [0, 1],
      [2, 5],
    ],
  },
  stats: {
    textual: { added: 4, removed: 1 },
    visible: { added: 1, removed: 1 },
  },
};

const plainDiff = (lines: number): StructuralDiff => ({
  type: "text",
  lhs: { text: text(lines), regions: [leaf(1, 1, [0, lines], [0])] },
  rhs: { text: text(lines), regions: [leaf(2, 1, [0, lines], [0])] },
  structural_changes: { base: [[0, 1]], head: [[0, 1]] },
  stats: {
    textual: { added: 1, removed: 1 },
    visible: { added: 1, removed: 1 },
  },
});

it("folds what diffr folds: hidden regions' changed lines, or a hidden file's", () => {
  expect(foldedChanges(undefined, sourceDiff)).toEqual({
    base: [],
    head: [[2, 5]],
  });
  // What stays unfolded is exactly what diffr counts in stats.visible.
  expect(
    foldedChanges({ collapsed: true, label: "Test file" }, sourceDiff),
  ).toEqual(sourceDiff.structural_changes);
  expect(foldedChanges(undefined, plainDiff(3))).toEqual({
    base: [],
    head: [],
  });
});

it("a paired leaf folds only its changed lines, and a visible leaf wins a shared line", () => {
  const diff: StructuralDiff = {
    type: "text",
    lhs: { text: text(4), regions: [leaf(1, 7, [0, 4], [1, 3])] },
    rhs: {
      text: text(4),
      regions: [
        fold(2, [0, 3], true, [leaf(3, 7, [0, 3], [0, 2])]),
        leaf(4, 8, [2, 4]),
      ],
    },
    structural_changes: {
      base: [
        [1, 2],
        [3, 4],
      ],
      head: [
        [0, 1],
        [2, 4],
      ],
    },
    stats: {
      textual: { added: 3, removed: 2 },
      visible: { added: 2, removed: 2 },
    },
  };

  expect(foldedChanges(undefined, diff)).toEqual({
    base: [],
    head: [[0, 1]],
  });
});

it("any region diffr collapses folds its changed lines, whatever its kind: a docstring counts as done", () => {
  // A function whose docstring diffr starts collapsed; one docstring line and
  // one body line changed. The rule reads the collapsed flag, not the tag.
  const docstring: StructuralRegion = {
    ...fold(2, [1, 4], true, [leaf(3, 3, [1, 4], [2])]),
    tags: ["summarize:docstring"],
  };

  const diff: StructuralDiff = {
    type: "text",
    lhs: {
      text: text(5),
      regions: [
        leaf(1, 1, [0, 1]),
        leaf(4, 3, [1, 4], [2]),
        leaf(5, 5, [4, 5], [4]),
      ],
    },
    rhs: {
      text: text(5),
      regions: [leaf(6, 1, [0, 1]), docstring, leaf(7, 5, [4, 5], [4])],
    },
    structural_changes: {
      base: [
        [2, 3],
        [4, 5],
      ],
      head: [
        [2, 3],
        [4, 5],
      ],
    },
    stats: {
      textual: { added: 2, removed: 2 },
      visible: { added: 1, removed: 2 },
    },
  };

  const folded = foldedChanges(undefined, diff);
  expect(folded).toEqual({ base: [], head: [[2, 3]] });
  expect(
    coverageProgress([
      {
        path: "doc.py",
        fingerprint: "f",
        changed: diff.structural_changes,
        folded,
        viewed: {
          base: [
            [2, 3],
            [4, 5],
          ],
          head: [[4, 5]],
        },
      },
    ]),
  ).toMatchObject({
    state: "viewed",
    remaining: { additions: 0, deletions: 0 },
    folded: { additions: 1, deletions: 0 },
  });
});

let directory: string, store: SessionStore;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "whiteboard-folded-"));
  vi.stubEnv("DEV_REVIEW_HOME", directory);

  const providers: SessionProviders = {
    validatePins: vi.fn<SessionProviders["validatePins"]>(async () => {}),
    validateSource: vi.fn<SessionProviders["validateSource"]>(async () => {}),
    validateResource: vi.fn<SessionProviders["validateResource"]>(
      async () => {},
    ),
  };

  store = new SessionStore(path.join(directory, "reviews.db"), providers);
});

afterEach(async () => {
  await store.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

const ref = (path: string) => ({
  lhs: { path, oid: "base", mode: "100644" },
  rhs: { path, oid: "head", mode: "100644" },
});

const records: {
  path: string;
  diff: StructuralDiff;
  visibility?: { collapsed: boolean; label: string };
}[] = [
  { path: "src/api.rs", diff: sourceDiff },
  { path: "src/main.rs", diff: plainDiff(2) },
  {
    path: "Cargo.lock",
    diff: plainDiff(2),
    visibility: {
      collapsed: true,
      label: "Generated file · hidden by default",
    },
  },
  { path: "docs/readme.md", diff: plainDiff(2) },
];

async function progressApi() {
  const run = <Operation>(operation: Operation) =>
    store.execute({ commandId: randomUUID(), operation });

  const { sessionId } = await run({ type: "create", title: "Folds", pins });
  await run({
    type: "lens",
    sessionId,
    edit: {
      type: "insert",
      title: "Rust",
      targets: [{ kind: "files", patterns: ["src/**", "Cargo.lock"] }],
    },
  });

  const data = new LocalSessionData(store);
  vi.spyOn(data, "resolveSource").mockImplementation(async (snapshot) => ({
    snapshot,
    pins: snapshot.pins!,
  }));
  vi.spyOn(data, "structuralChanges").mockImplementation(async function* () {
    yield {
      type: "start",
      version: 4,
      lhs: { type: "revision", rev: "base" },
      rhs: { type: "revision", rev: "head" },
      files: records.map(({ path }) => ({
        file: ref(path),
        status: "modified" as const,
      })),
    } satisfies StructuralDiffEvent;

    for (const { path, diff, visibility } of records)
      yield { type: "file", file: ref(path), diff, visibility };
    yield { type: "complete", succeeded: records.length, failed: 0 };
  });

  const app = createSessionApi(store, data);

  const client = new SessionApiClient(
    { serverUrl: "http://review", token: "token" },
    async (url, init) =>
      app.request(
        String(url).replace("http://whiteboard/sessions-api", ""),
        init,
      ),
  );

  return { sessionId, client };
}

it("progress counts folded changes as done, overall, per lens and uncategorized", async () => {
  const { sessionId, client } = await progressApi();
  const progress = await client.read<WhiteboardProgress>(
    `/${sessionId}/progress`,
  );

  const lens = (id: string) =>
    progress.lenses.find((lens) => lens.id === id)!.sources;

  // 4+1 in api.rs (3 folded), 1+1 in each other file, the lockfile folded.
  expect(coverageProgress(progress.files)).toEqual({
    state: "unread",
    total: { additions: 7, deletions: 4 },
    remaining: { additions: 3, deletions: 3 },
    folded: { additions: 4, deletions: 1 },
  });
  expect(coverageProgress(progress.files, lens("lens-1"))).toMatchObject({
    remaining: { additions: 2, deletions: 2 },
    folded: { additions: 4, deletions: 1 },
  });
  expect(
    coverageProgress(progress.files, lens(UNCATEGORIZED_LENS_ID)),
  ).toMatchObject({
    remaining: { additions: 1, deletions: 1 },
    folded: { additions: 0, deletions: 0 },
  });

  const file = (path: string) =>
    progress.files.find((file) => file.path === path)!;

  expect(coverageProgress([file("Cargo.lock")]).state).toBe("folded");

  // Viewing every unfolded line reads 100%, with the folded code unopened.
  const viewed = await client.post<WhiteboardProgress>(
    `/${sessionId}/progress`,
    {
      mode: "structural",
      version: store.read(sessionId).version,
      viewed: true,
      files: ["src/api.rs", "src/main.rs", "docs/readme.md"].map((path) => ({
        path,
        fingerprint: file(path).fingerprint,
        sources: coverageSources(file(path), file(path).changed).filter(
          (source) => !(path === "src/api.rs" && source.fromLine > 1),
        ),
      })),
    },
  );

  const after = coverageProgress(viewed.files);
  expect(after.remaining).toEqual({ additions: 0, deletions: 0 });
  expect(after.state).toBe("viewed");
  expect(
    coverageProgress(
      viewed.files,
      viewed.lenses.find((lens) => lens.id === "lens-1")!.sources,
    ).state,
  ).toBe("viewed");
});
