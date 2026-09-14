import type {
  HostAttention,
  HostRepository,
  HostReviewState,
  HostReviewWithSnapshot,
  ReviewCanvasContent,
  ReviewClient,
  ReviewDescriptor,
} from "@dev.fast/review-protocol";
import { useEffect, useRef, useState } from "react";

import { ReviewHome } from "./review-home-view";

/** Adapts API records to the existing Home view; it owns no review storage. */
export function hostReviewDescriptor(
  value: HostReviewWithSnapshot,
  repository: HostRepository | undefined,
  attention?: HostAttention,
): ReviewDescriptor {
  const { review, snapshot } = value;
  const binding = snapshot.binding;
  return {
    uuid: review.id,
    title: snapshot.title,
    status: review.state === "closed" ? "accepted" : "awaiting-review",
    // The host deliberately does not expose filesystem paths. Group using
    // the repository's public identity until worktree metadata is available.
    worktreePath: repository?.displayName ?? review.repositoryId,
    repoKey: review.repositoryId,
    sourceBranch:
      binding.selector.kind === "branch"
        ? binding.selector.name
        : binding.selector.kind === "range"
          ? binding.selector.headRef
          : null,
    pullRequestUrl:
      binding.selector.kind === "pull_request" ? binding.selector.url : null,
    baseRef: binding.baseCommit,
    headRef: binding.headCommit,
    presentedDocumentRevision: String(snapshot.reviewVersion),
    presentedSoftwareMapRevision: null,
    lastPublishedAt: null,
    documentUpdatedAt: snapshot.createdAt,
    available: !review.deletedAt,
    viewedAt: attention?.lastViewedAt ?? null,
    dismissedAt: review.deletedAt,
    reapsAt: null,
  };
}

export function HostReviewHome({
  client,
  content,
}: {
  client: ReviewClient;
  content: Extract<ReviewCanvasContent, { kind: "host" }>;
}) {
  const [reviews, setReviews] = useState<ReviewDescriptor[]>();
  const [error, setError] = useState<string>();
  const refreshRef = useRef<() => Promise<string>>(async () => "");
  const records = useRef(new Map<string, HostReviewState>());
  useEffect(() => {
    const abort = new AbortController();
    const refresh = async () => {
      const [first, repositoryPage] = await Promise.all([
        client.query(
          "reviews.list",
          { limit: 200, includeTrash: true },
          abort.signal,
        ),
        client.query("repositories.list", { limit: 200 }, abort.signal),
      ]);
      const all = [...first.result.items];
      let cursor = first.result.nextCursor;
      while (cursor) {
        const page = await client.query(
          "reviews.list",
          { limit: 200, includeTrash: true, cursor },
          abort.signal,
        );
        all.push(...page.result.items);
        cursor = page.result.nextCursor;
      }
      const repositories = new Map(
        repositoryPage.result.items.map((repository) => [
          repository.id,
          repository,
        ]),
      );
      cursor = repositoryPage.result.nextCursor;
      while (cursor) {
        const page = await client.query(
          "repositories.list",
          { limit: 200, cursor },
          abort.signal,
        );
        for (const repository of page.result.items)
          repositories.set(repository.id, repository);
        cursor = page.result.nextCursor;
      }
      const descriptors = await Promise.all(
        all.map(async (value) => {
          const attention = await client.query(
            "attention.get",
            { reviewId: value.review.id },
            abort.signal,
          );
          return hostReviewDescriptor(
            value,
            repositories.get(value.review.repositoryId),
            attention.result,
          );
        }),
      );
      if (!abort.signal.aborted) {
        records.current = new Map(all.map(({ review }) => [review.id, review]));
        setReviews(descriptors);
        setError(undefined);
      }
      return first.eventCursor;
    };
    // Serialize event refreshes so an older list cannot overwrite a newer one.
    let pending = Promise.resolve("");
    const refreshInOrder = () => {
      pending = pending.catch(() => "").then(refresh);
      return pending;
    };
    refreshRef.current = refreshInOrder;
    void refreshInOrder()
      .then((after) =>
        client.subscribe({
          after,
          signal: abort.signal,
          onReset: refreshInOrder,
          onEvent: (event) =>
            event.type === "attention.updated" ||
            event.type.startsWith("review.") ||
            event.type.startsWith("document.")
              ? refreshInOrder()
              : undefined,
          onError: (failure) => {
            if (!abort.signal.aborted) setError(failure.message);
          },
        }),
      )
      .catch((cause: unknown) => {
        if (!abort.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => abort.abort();
  }, [client]);

  const changeAttention = async (
    review: ReviewDescriptor,
    action: "review.trash" | "review.untrash",
  ) => {
    const record = records.current.get(review.uuid);
    if (!record) return;
    await client.command(action, {
      reviewId: record.id,
      expectedStateVersion: record.stateVersion,
    });
    if (action === "review.trash") await content.closeReview?.(review.uuid);
    await refreshRef.current();
  };
  if (!reviews)
    return (
      <main className="review-home">
        <p role={error ? "alert" : "status"}>{error ?? "Loading reviews…"}</p>
      </main>
    );
  return (
    <>
      {error && <p role="alert">{error}</p>}
      <ReviewHome
        reviews={reviews}
        onOpen={(review) => content.openReview(review.uuid, review.title)}
        onDismiss={(review) => changeAttention(review, "review.trash")}
        onRestore={(review) => changeAttention(review, "review.untrash")}
        onOpenSourceTree={
          content.openSourceTree
            ? (review) => content.openSourceTree?.(review.uuid)
            : undefined
        }
        setup={content.setup}
        install={content.install}
        onboarding={content.onboarding}
        onOpenTutorial={content.openTutorial}
      />
    </>
  );
}
