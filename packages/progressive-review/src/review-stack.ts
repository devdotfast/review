import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ReviewStackLayer } from "@dev.fast/review-protocol";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const GhStackViewSchema = z.object({
  branches: z.array(
    z.object({
      name: z.string().min(1),
      pr: z
        .object({
          number: z.number().int().positive(),
          url: z.string().url().optional(),
        })
        .optional(),
    }),
  ),
});

export interface ReviewStackSubject {
  repoKey: string;
  worktreePath: string;
  pullRequestNumber?: number | null;
}

export interface ReviewStackCandidate {
  uuid: string;
  title: string;
  repoKey: string;
  pullRequestNumber?: number | null;
  presentedDocumentRevision: string | null;
}

export type RunGhStackView = (cwd: string) => Promise<string>;

export async function resolveReviewStackLayers(
  subject: ReviewStackSubject,
  reviews: readonly ReviewStackCandidate[],
  runGhStackView: RunGhStackView = defaultRunGhStackView,
): Promise<ReviewStackLayer[]> {
  if (!subject.pullRequestNumber) return [];

  let parsed: z.infer<typeof GhStackViewSchema>;
  try {
    parsed = GhStackViewSchema.parse(
      JSON.parse(await runGhStackView(subject.worktreePath)),
    );
  } catch {
    // Stack support is an enhancement. Missing gh-stack, an unrelated
    // checkout, authentication failures, and preview-schema changes must not
    // make the Review itself unavailable.
    return [];
  }

  const currentIndex = parsed.branches.findIndex(
    (branch) => branch.pr?.number === subject.pullRequestNumber,
  );
  if (currentIndex < 0) return [];

  return parsed.branches.flatMap((branch, index) => {
    if (!branch.pr) return [];
    const review = reviews.find(
      (candidate) =>
        candidate.repoKey === subject.repoKey &&
        candidate.pullRequestNumber === branch.pr?.number &&
        candidate.presentedDocumentRevision,
    );
    return [
      {
        branch: branch.name,
        pullRequestNumber: branch.pr.number,
        pullRequestUrl: branch.pr.url ?? null,
        reviewUuid: review?.uuid ?? null,
        reviewTitle: review?.title ?? null,
        relation:
          index < currentIndex
            ? "earlier"
            : index === currentIndex
              ? "current"
              : "later",
      },
    ];
  });
}

async function defaultRunGhStackView(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("gh", ["stack", "view", "--json"], {
    cwd,
    env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout;
}
