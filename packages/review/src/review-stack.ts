import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ReviewStackLayer } from "@dev.fast/review-protocol";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const GitHubStacksSchema = z.array(
  z.object({
    pull_requests: z.array(
      z.object({
        number: z.number().int().positive(),
        head: z.object({ ref: z.string().min(1) }),
      }),
    ),
  }),
);

export interface ReviewStackSubject {
  pullRequestUrl?: string | null;
}

export interface ReviewStackCandidate {
  uuid: string;
  title: string;
  repoKey: string;
  pullRequestNumber?: number | null;
  presentedDocumentRevision: string | null;
}

export type RunGitHubApi = (endpoint: string) => Promise<string>;

export async function resolveReviewStackLayers(
  subject: ReviewStackSubject,
  reviews: readonly ReviewStackCandidate[],
  runGitHubApi: RunGitHubApi = defaultRunGitHubApi,
): Promise<ReviewStackLayer[]> {
  const binding = subject.pullRequestUrl?.match(
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)$/,
  );

  if (!binding) return [];
  const [, owner, repository, number] = binding;
  const pullRequestNumber = Number(number);
  const repoKey = `https://github.com/${owner}/${repository}`;
  let stacks: z.infer<typeof GitHubStacksSchema>;

  try {
    stacks = GitHubStacksSchema.parse(
      JSON.parse(
        await runGitHubApi(
          `repos/${owner}/${repository}/stacks?pull_request=${number}`,
        ),
      ),
    );
  } catch {
    // Stack discovery must not make the Review unavailable when GitHub or
    // authentication is unavailable, or stacks are not enabled for the repo.
    return [];
  }

  const stack = stacks.find((candidate) =>
    candidate.pull_requests.some((pr) => pr.number === pullRequestNumber),
  );

  if (!stack) return [];

  const currentIndex = stack.pull_requests.findIndex(
    (pr) => pr.number === pullRequestNumber,
  );

  return stack.pull_requests.map((pr, index) => {
    const review = reviews.find(
      (candidate) =>
        candidate.repoKey === repoKey &&
        candidate.pullRequestNumber === pr.number &&
        candidate.presentedDocumentRevision,
    );

    return {
      branch: pr.head.ref,
      pullRequestNumber: pr.number,
      pullRequestUrl: `${repoKey}/pull/${pr.number}`,
      reviewUuid: review?.uuid ?? null,
      reviewTitle: review?.title ?? null,
      relation:
        index < currentIndex
          ? "earlier"
          : index === currentIndex
            ? "current"
            : "later",
    };
  });
}

async function defaultRunGitHubApi(endpoint: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "gh",
    ["api", "--hostname", "github.com", endpoint],
    {
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );

  return stdout;
}
