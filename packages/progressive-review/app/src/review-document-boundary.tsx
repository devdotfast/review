import { Component, type ErrorInfo, type ReactNode } from "react";

import type { ReviewSession } from "./host/review-session";
import { ReviewCanvasLoading } from "./review-canvas-loading";
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
  private reportedRevision: string | null = null;

  static getDerivedStateFromProps(
    props: ReviewDocumentBoundaryProps,
    state: ReviewDocumentBoundaryState,
  ): ReviewDocumentBoundaryState | null {
    return props.revision !== state.revision
      ? { revision: props.revision, hasError: false }
      : null;
  }

  static getDerivedStateFromError(): Pick<
    ReviewDocumentBoundaryState,
    "hasError"
  > {
    return { hasError: true };
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
        <ReviewCanvasLoading
          message="Your coding agent is writing the canvas now…"
          note={
            <>
              Your agent is debugging the canvas candidate from{" "}
              <code>review publish</code>.
            </>
          }
        />
      );
    }
    return this.props.children;
  }
}
