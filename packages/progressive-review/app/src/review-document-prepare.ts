import {
  resolveCodePeekRequest,
  runWithCodePeekResolutionSlot,
} from "./code-peek-resolution";
import type { ReviewSession } from "./host/review-session";
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
): Promise<void> {
  const resolveCodePeek = options.resolveCodePeek ?? resolveCodePeekRequest;
  const uniqueAnchors = new Set(document.anchors.values());
  await Promise.all(
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
}

/**
 * One hydration per content hash for the life of a session: the canvas
 * remounts the document on every view change, and peek resolution must not
 * re-run for a document the session already prepared.
 */
export function prepareReviewDocument(
  load: ReadyReviewDocumentLoad,
  session: ReviewSession,
  options: ResolveReviewDocumentPeeksOptions = {},
): Promise<HydratedReviewDocument> {
  const cached = session.documents.get(load.contentHash);
  if (cached) return cached;
  const prepared = hydrateAndResolve(load, session, options);
  session.documents.set(load.contentHash, prepared);
  void prepared.catch(() => {
    if (session.documents.get(load.contentHash) === prepared) {
      session.documents.delete(load.contentHash);
    }
  });
  return prepared;
}

async function hydrateAndResolve(
  load: ReadyReviewDocumentLoad,
  session: ReviewSession,
  options: ResolveReviewDocumentPeeksOptions,
): Promise<HydratedReviewDocument> {
  const document = hydrateReviewDocument(load);
  await resolveReviewDocumentPeeks(document, session, options);
  return document;
}
