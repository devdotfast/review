import type { Writable } from "node:stream";

import {
  SessionApiClient,
  type SessionSummary,
} from "@dev.fast/review-protocol";

import {
  readReviewDesktopDiscovery,
  requireHealthyReviewDesktop,
} from "./desktop-discovery";
import { focusReviewDesktop, runReviewAppLaunch } from "./review-app-launcher";
import { pickReview } from "./review-app-picker";
import { resolveReviewRoot } from "./runtime";

interface ReviewAppRuntime {
  launch: typeof runReviewAppLaunch;
  readReviewDesktopDiscovery: typeof readReviewDesktopDiscovery;
  requireHealthyReviewDesktop: typeof requireHealthyReviewDesktop;
  resolveReviewRoot: typeof resolveReviewRoot;
  pickReview: typeof pickReview;
  fetch: typeof globalThis.fetch;
}

export interface RunReviewAppInput {
  cwd: string;
  sessionId?: string;
  /** Bring Review Desktop forward. */
  focus?: boolean;
  stdin: NodeJS.ReadStream;
  stdout: Writable;
}

export interface ReviewAppEvent {
  event: "app";
  action: "pick";
  sessionId: string;
  title: string;
  cancelled?: boolean;
}

export async function runReviewAppPick(
  input: RunReviewAppInput,
  overrides: Partial<ReviewAppRuntime> = {},
): Promise<ReviewAppEvent | null> {
  const runtime = {
    launch: runReviewAppLaunch,
    readReviewDesktopDiscovery,
    requireHealthyReviewDesktop,
    resolveReviewRoot,
    pickReview,
    fetch: globalThis.fetch,
    ...overrides,
  };

  // Only `review app launch` may recover a stale or incompatible pointer; the
  // other verbs report the diagnosis rather than start a second Desktop. A null
  // read means nothing is running, which launching does fix.
  let launched = false;

  if (!(await runtime.readReviewDesktopDiscovery())) {
    await runtime.launch({ focus: input.focus });
    launched = true;
  }

  const discovery = await runtime.requireHealthyReviewDesktop(
    "review app pick",
    {
      readDiscovery: runtime.readReviewDesktopDiscovery,
      fetch: runtime.fetch,
    },
  );

  const client = new SessionApiClient(
    {
      serverUrl: discovery.url,
      apiPath: "/sessions-api",

      token: discovery.token,
    },
    runtime.fetch,
  );

  let review: Pick<SessionSummary, "sessionId" | "title">;

  if (input.sessionId) {
    // Without `full`, GET /sessions-api/:id answers inspectSnapshot(): block
    // descriptors with no sessionId or title.
    review = await client.read(
      `/${encodeURIComponent(input.sessionId)}?full=true`,
    );
  } else {
    if (!input.stdin.isTTY)
      throw new Error(
        "review app pick needs a terminal without --review. Pass --review <uuid> or run it in a terminal.",
      );
    const root = await runtime.resolveReviewRoot(input.cwd);

    const reviews = (await client.read<SessionSummary[]>(""))
      .filter((review) => review.repositoryPath === root && !review.dismissedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    if (!reviews.length) throw new Error("No review to show.");

    const picked = await runtime.pickReview(
      reviews.map((review) => ({
        uuid: review.sessionId,
        title: review.title,
        status: review.viewedAt ? "viewed" : "new",
        lastPublishedAt: review.createdAt,
      })),
      input,
    );

    if (!picked) return null;
    review = { sessionId: picked.uuid, title: picked.title };
  }

  await client.post(`/${encodeURIComponent(review.sessionId)}/open`, {});

  // A focused fresh launch already came forward; a running one must be asked.
  if (input.focus && !launched)
    await focusReviewDesktop(discovery, runtime.fetch);

  return {
    event: "app",
    action: "pick",
    sessionId: review.sessionId,
    title: review.title,
  };
}
