import { readReviewDesktopDiscovery } from "./desktop-discovery";
import { hasLiveReviewPage } from "./live-review-store";
import { runReviewAppLaunch } from "./review-app-launcher";
import { type ReviewPickerItem, pickReview } from "./review-app-picker";
import { actionableReviewsForCheckout } from "./review-change-scope";
import { type StoredReview, listReviews } from "./review-home";
import { resolveReviewRoot } from "./runtime";

interface ReviewAppRuntime {
  launch: typeof runReviewAppLaunch;
  readReviewDesktopDiscovery: typeof readReviewDesktopDiscovery;
  listReviews: typeof listReviews;
  resolveReviewRoot: typeof resolveReviewRoot;
  pickReview: typeof pickReview;
  hasLiveReviewPage: typeof hasLiveReviewPage;
  fetch: typeof globalThis.fetch;
}

export interface RunReviewAppInput {
  cwd: string;
  reviewUuid?: string;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

export interface ReviewAppEvent {
  event: "app";
  action: "pick";
  reviewUuid: string;
  title: string;
  cancelled?: boolean;
}

export async function runReviewAppPick(
  input: RunReviewAppInput,
  overrides: Partial<ReviewAppRuntime> = {},
): Promise<ReviewAppEvent | null> {
  const runtime: ReviewAppRuntime = {
    launch: runReviewAppLaunch,
    readReviewDesktopDiscovery,
    listReviews,
    resolveReviewRoot,
    pickReview,
    hasLiveReviewPage,
    fetch: globalThis.fetch,
    ...overrides,
  };
  await runtime.launch();
  const reviewRoot = await runtime.resolveReviewRoot(input.cwd);
  const listed = await runtime.listReviews({ worktreePath: reviewRoot });
  if (listed.errors.length > 0) {
    throw new Error(
      `Could not read reviews:\n${listed.errors.map((error) => error.message).join("\n")}`,
    );
  }
  const review = input.reviewUuid
    ? resolveAppReview(
        listed.reviews,
        input.reviewUuid,
        runtime.hasLiveReviewPage,
      )
    : await pickAppReview(
        await actionableReviewsForCheckout(listed.reviews, reviewRoot),
        input,
        runtime,
      );
  if (!review) return null;
  const discovery = await runtime.readReviewDesktopDiscovery();
  if (!discovery) {
    throw new Error(
      "Review Desktop is not ready. Run `review app launch` and retry `review app pick`.",
    );
  }
  const response = await runtime.fetch(
    `${discovery.url}/reviews/${encodeURIComponent(review.review.uuid)}/open`,
    {
      method: "POST",
      headers: { "x-review-token": discovery.token },
    },
  );
  const payload: unknown = await response.json();
  if (!response.ok) {
    throw new Error(reviewAppResponseError(payload, response.status));
  }
  return {
    event: "app",
    action: "pick",
    reviewUuid: review.review.uuid,
    title: review.review.title,
  };
}

export const runReviewApp = runReviewAppPick;

function resolveAppReview(
  reviews: readonly StoredReview[],
  reviewUuid: string,
  hasLivePage: typeof hasLiveReviewPage,
): StoredReview {
  const selected = reviews.find((review) => review.review.uuid === reviewUuid);
  if (!selected) throw new Error(`Review not found: ${reviewUuid}`);
  if (
    selected.review.presentedDocumentRevision === null &&
    !hasLivePage(selected.dir)
  ) {
    throw new Error(
      `Review ${reviewUuid} is not published. Run \`review publish --review ${reviewUuid}\` first.`,
    );
  }
  return selected;
}

async function pickAppReview(
  reviews: readonly StoredReview[],
  input: RunReviewAppInput,
  runtime: ReviewAppRuntime,
): Promise<StoredReview | null> {
  if (!input.stdin.isTTY) {
    throw new Error(
      "review app pick needs a terminal without --review. Pass --review <uuid> or run it in a terminal.",
    );
  }
  const openable = reviews.filter(
    (review) =>
      review.review.presentedDocumentRevision !== null ||
      runtime.hasLiveReviewPage(review.dir),
  );
  if (openable.length === 0) {
    throw new Error("No published review to show. Run `review publish` first.");
  }
  const items: ReviewPickerItem[] = [...openable]
    .sort((left, right) =>
      (right.review.lastPublishedAt ?? "").localeCompare(
        left.review.lastPublishedAt ?? "",
      ),
    )
    .map((review) => ({
      uuid: review.review.uuid,
      title: review.review.title,
      status: review.review.status,
      lastPublishedAt: review.review.lastPublishedAt,
    }));
  const picked = await runtime.pickReview(items, {
    stdin: input.stdin,
    stdout: input.stdout,
  });
  if (!picked) return null;
  return resolveAppReview(reviews, picked.uuid, runtime.hasLiveReviewPage);
}

function reviewAppResponseError(payload: unknown, status: number): string {
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error;
  }
  return `Review Desktop returned ${status} for app open.`;
}
