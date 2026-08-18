import type {
  ReviewCommitScope,
  ReviewDiffViewHandle,
} from "@dev.fast/review-protocol";
import { useLayoutEffect, useState } from "react";

import { useReviewSession } from "./host/review-session";

/**
 * Hosts the workbench diff UI — the changed-file list beside the multi-diff
 * widget — inside the Review tab. The app owns the container; the workbench
 * mounts native widgets into it through the bridge.
 */
export function ReviewDiffView({ scope }: { scope?: ReviewCommitScope }) {
  const session = useReviewSession();
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const diffViewFactory = session.bridge.diffView;
  const diffViewSessionId = session.config.sessionId;

  useLayoutEffect(() => {
    if (!container) return;
    setError(null);
    let handle: ReviewDiffViewHandle;
    try {
      handle = diffViewFactory.create({ container, scope });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return;
    }
    const errorSubscription = handle.onDidError(setError);
    return () => {
      errorSubscription.dispose();
      handle.dispose();
    };
  }, [container, diffViewFactory, diffViewSessionId, scope?.commit]);

  return (
    <>
      <div ref={setContainer} className="review-diff-view-host" />
      {error ? (
        <div className="review-diff-view-error" title={error}>
          Diff unavailable
        </div>
      ) : null}
    </>
  );
}
