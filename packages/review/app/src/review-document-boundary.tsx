import { Component, type ErrorInfo, type ReactNode } from "react";

import type { ReviewSession } from "./host/review-session";
import { ReviewUnavailable } from "./review-empty-state";
import { captureClientError } from "./ui-telemetry";

interface ReviewDocumentBoundaryProps {
  session: ReviewSession;
  revision: string;
  onError: (revision: string, error: Error) => void;
  children: ReactNode;
}

interface ReviewDocumentBoundaryState {
  hasError: boolean;
  revision: string;
}

export class ReviewDocumentBoundary extends Component<
  ReviewDocumentBoundaryProps,
  ReviewDocumentBoundaryState
> {
  state: ReviewDocumentBoundaryState = {
    hasError: false,
    revision: this.props.revision,
  };
  private reportedRevision: string | undefined;

  static getDerivedStateFromError(): Pick<
    ReviewDocumentBoundaryState,
    "hasError"
  > {
    return { hasError: true };
  }

  static getDerivedStateFromProps(
    props: ReviewDocumentBoundaryProps,
    state: ReviewDocumentBoundaryState,
  ): ReviewDocumentBoundaryState | null {
    // New content gets a fresh render; the last failure was for the old revision.
    return props.revision === state.revision
      ? null
      : { hasError: false, revision: props.revision };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    if (this.reportedRevision === this.props.revision) return;
    this.reportedRevision = this.props.revision;
    captureClientError(this.props.session, "render", error);
    this.props.onError(this.props.revision, error);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <ReviewUnavailable
          role="status"
          message={
            <>
              Your coding agent is writing the canvas now…
              <br />
              Edit the review through the Review MCP tools or{" "}
              <code>review api</code> to replace the failing block.
            </>
          }
        />
      );
    }

    return this.props.children;
  }
}
