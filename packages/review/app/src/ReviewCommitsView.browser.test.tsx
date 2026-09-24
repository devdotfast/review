import type {
  ReviewCanvasBridge,
  ReviewCommitSummary,
  ReviewDiffFileWire,
  ReviewDiffViewHandle,
} from "@dev.fast/review-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { ReviewDiffView } from "./DiffView";
import { ReviewSessionProvider } from "./host/review-session";
import { testReviewSession } from "./review-session-test-utils";
import { ReviewCommitsView } from "./ReviewCommitsView";

let root: ReturnType<typeof createRoot> | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
});

const commit: ReviewCommitSummary = {
  commit: "c".repeat(40),
  parentCommit: "p".repeat(40),
  subject: "Change the thing",
  author: "Developer",
  authoredAt: new Date(2026, 8, 23, 12).toISOString(),
  fileCount: 1,
  additions: 3,
  deletions: 1,
};

const file: ReviewDiffFileWire = {
  path: "src/thing.ts",
  status: "modified",
  additions: 3,
  deletions: 1,
};

async function mount(
  element: React.ReactElement,
  diffView: ReviewCanvasBridge["diffView"],
) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  await act(async () =>
    root!.render(
      <ReviewSessionProvider session={testReviewSession({}, { diffView })}>
        {element}
      </ReviewSessionProvider>,
    ),
  );

  return container;
}

it("opens a commit's diff at the file clicked in its file list", async () => {
  const onOpenDiff =
    vi.fn<React.ComponentProps<typeof ReviewCommitsView>["onOpenDiff"]>();

  const container = await mount(
    <ReviewCommitsView
      commits={[commit]}
      range={{
        baseRef: "main",
        headRef: "feature",
        baseCommit: "a".repeat(40),
        headCommit: commit.commit,
      }}
      onOpenDiff={onOpenDiff}
    />,
    { files: async () => [file], create: () => ({}) as ReviewDiffViewHandle },
  );

  await act(async () =>
    container.querySelector<HTMLButtonElement>("[aria-expanded]")!.click(),
  );
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes(file.path))!
      .click(),
  );

  expect(onOpenDiff).toHaveBeenCalledWith(commit, "file", file.path);
});

it("reveals the requested file in a commit-scoped diff", async () => {
  const revealFile = vi.fn<NonNullable<ReviewDiffViewHandle["revealFile"]>>();

  await mount(
    <ReviewDiffView scope={{ commit: commit.commit }} revealFile={file.path} />,
    {
      files: async () => [],
      create: () => ({
        focus() {},
        revealFile,
        onDidError: () => ({ dispose() {} }),
        dispose() {},
      }),
    },
  );

  expect(revealFile).toHaveBeenCalledWith(file.path);
});
