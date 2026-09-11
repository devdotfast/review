import {
  resolveCodePeekRequest,
  runWithCodePeekResolutionSlot,
} from "./code-peek-resolution";
import type {
  ReviewDocumentCacheEntry,
  ReviewSession,
} from "./host/review-session";
import {
  type HydratedReviewDocument,
  type ReadyReviewDocumentLoad,
  hydrateReviewDocument,
} from "./review-document-hydrate";

/** The resolver is a parameter so tests can drive it without module mocking. */
export interface ResolveReviewDocumentPeeksOptions {
  resolveCodePeek?: typeof resolveCodePeekRequest;
}

export async function resolveReviewDocumentPeeks(
  document: HydratedReviewDocument,
  session: ReviewSession,
  options: ResolveReviewDocumentPeeksOptions = {},
): Promise<boolean> {
  const resolveCodePeek = options.resolveCodePeek ?? resolveCodePeekRequest;
  const uniqueAnchors = new Set(document.anchors.values());

  const results = await Promise.allSettled(
    [...uniqueAnchors].flatMap((anchor) => {
      if (!anchor.peek || anchor.peek.resolution) return [];

      return [
        runWithCodePeekResolutionSlot(async () => {
          anchor.peek!.resolution = await resolveCodePeek(
            document.routePath,
            anchor.peek!.props,
            session,
          );
        }),
      ];
    }),
  );

  // A missing source must fail only its peek card, not the whole document.
  return results.every((result) => result.status === "fulfilled");
}

/**
 * Reuse hydration across remounts while a content hash remains in the
 * session's bounded cache. Failed peeks retry on the same hydrated document,
 * preserving successful resolutions and refs.
 */
export function prepareReviewDocument(
  load: ReadyReviewDocumentLoad,
  session: ReviewSession,
  options: ResolveReviewDocumentPeeksOptions = {},
): Promise<HydratedReviewDocument> {
  let cached = session.documents.get(load.contentHash);

  if (!cached) {
    try {
      cached = { document: hydrateReviewDocument(load), complete: false };
    } catch (error) {
      // Invalid hydration must never occupy the content hash's cache entry.
      return Promise.reject(error);
    }

    session.documents.set(load.contentHash, cached);

    // A live authoring session can produce thousands of native revisions.
    if (session.documents.size > 16)
      session.documents.delete(session.documents.keys().next().value!);
  }

  if (cached.preparation) return cached.preparation;

  if (cached.complete) return Promise.resolve(cached.document);

  return prepareCachedDocument(cached, session, options);
}

function prepareCachedDocument(
  cached: ReviewDocumentCacheEntry,
  session: ReviewSession,
  options: ResolveReviewDocumentPeeksOptions,
): Promise<HydratedReviewDocument> {
  // Publish the shared attempt before invoking any resolver, including a
  // resolver that synchronously prepares another view of the same document.
  cached.preparation = Promise.resolve()
    .then(() => resolveReviewDocumentPeeks(cached.document, session, options))
    .then((complete) => {
      cached.complete = complete;

      return cached.document;
    })
    .finally(() => {
      cached.preparation = undefined;
    });

  return cached.preparation;
}
